#!/usr/bin/env node
// Message Board · 成员运行器
//
// 把「被点名」变成「真的回应」：常驻监听黑板，一被 @ 就唤起背后的 agent，
// 把它的答复作为该成员的留言写回黑板（带 replyTo）。
//
// 支持的引擎（engine）—— 黑板核心不认识厂商，只认识引擎接口：
//   openai-compatible  任意 OpenAI 兼容 /chat/completions（DeepSeek/OpenAI/本机 Ollama…）
//   command            任意本地命令：提示词进 stdin，答复出 stdout（Codex CLI 等）
//   codex-cli          本机 Codex CLI：codex exec -o <文件>（不依赖 stdout 管道）
//   rule-based         不调用任何模型的本地规则引擎（链路自检与排障基准）
//   human              引擎就是人：点名保持待回应，等人自己回复
// --engine-file <路径> 可外挂第三方引擎，核心代码零改动。
//
// 用法：
//   node bridges/agent-runner.js --agent codex --engine codex-cli \
//        --name Codex --title "项目主 Agent" --workdir "D:\some\repo" --sandbox read-only
//
//   node bridges/agent-runner.js --agent deepseek --engine openai-compatible --model deepseek-chat
//   node bridges/agent-runner.js --agent local --engine openai-compatible \
//        --engine-base-url http://127.0.0.1:11434/v1 --engine-model qwen2.5:7b
//   node bridges/agent-runner.js --agent probe --engine rule-based      # 不需要任何 AI
//
// 安全与纪律：
//   - 只回应「点名自己」的留言；自己发的留言、以及没有点自己的留言都不回应；
//   - `--max-turns` 限制本次进程最多回几条，避免两个自动成员互相点名刷屏；
//   - prompt 里明确要求「非必要不要 @ 别人」；
//   - 回复同样是普通留言：立刻被写入黑板，遵守只追加与状态措辞纪律。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { register, resolveEngine, runEngine, listEngines, checkEngine } from '../engines/registry.mjs';

const args = process.argv.slice(2);
function flag(name, fallback = null) {
  const inline = args.find((item) => item.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

const BOARD = (flag('board') || process.env.MB_BOARD || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const TOKEN = flag('token') || process.env.MB_TOKEN || '';
const AGENT = String(flag('agent') || '').toLowerCase();
// 引擎（engine）＝把点名变成回复的那一层。核心不认识任何厂商，只认识引擎接口。
// --provider 是历史叫法，等价的别名，保留兼容。
const PROVIDER = flag('engine') || flag('provider', 'deepseek-api');
const ENGINE_CMD = flag('engine-cmd') || process.env.MB_ENGINE_CMD || '';
const ENGINE_BASE_URL = flag('engine-base-url') || process.env.MB_ENGINE_BASE_URL || '';
const ENGINE_KEY = flag('engine-key') || process.env.MB_ENGINE_KEY || '';
const ENGINE_MODEL = flag('engine-model') || process.env.MB_ENGINE_MODEL || '';
const ENGINE_FILES = [flag('engine-file') || process.env.MB_ENGINE_FILE || ''].filter(Boolean);
// 引擎类别（local/cli/http/human）：human 表示"由人回复"，行为与自动引擎不同
const ENGINE_KIND = (() => {
  try {
    return resolveEngine(PROVIDER).meta.kind;
  } catch {
    return ''; // 未知名引擎交由 main() 报错，这里不抛
  }
})();
const WAIT_SECONDS = Math.max(5, Math.min(Number(flag('wait', 25)), 60));
const MAX_TURNS = Number(flag('max-turns', 5));
const TIMEOUT_MS = Number(flag('timeout', 420)) * 1000;
const ONCE = args.includes('--once');
const QUIET = args.includes('--quiet');
// 默认开启：收到点名先回一条「处理中」通知，让点名者看得见反应
const ACK = !args.includes('--no-ack');
// 默认开启：启动时补做最近一条未回应的点名（服务重启会清空内存队列，靠它兜底）
const CATCH_UP = !args.includes('--no-catch-up');
// codex-cli：把这次会话开在一个独立终端窗口里，人能看见"新对话正在跑"（引擎自己决定是否支持）
const VISIBLE = args.includes('--visible');

/* ── 议题 → 会话 id：支持续接的引擎（meta.resumable）会在同一议题上续接同一次对话 ── */

const RESUMABLE = (() => {
  try {
    return Boolean(resolveEngine(PROVIDER).meta.resumable);
  } catch {
    return false;
  }
})();

function sessionsFile() {
  return path.join(RUNTIME_DIR, 'sessions.json');
}

function readSessions() {
  try {
    return JSON.parse(fs.readFileSync(sessionsFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeSessions(map) {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(sessionsFile(), JSON.stringify(map, null, 2), 'utf8');
  } catch (error) {
    log(`会话表保存失败：${error.message}`);
  }
}

/** 议题（没有议题就用 __default__）→ 会话 id */
function sessionKeyFor(envelope) {
  return envelope.topic || '__default__';
}

if (!AGENT) {
  console.error('缺少 --agent <id>，例如 --agent codex');
  process.exit(1);
}

const IDENTITY = {
  id: AGENT,
  name: flag('name', AGENT),
  title: flag('title', '成员'),
  platform: flag('platform', PROVIDER === 'codex-cli' ? 'Codex CLI' : PROVIDER),
  mission: flag('mission', '按黑板上的点名为同伴提供可核验的答复'),
  skills: flag('skills', ''),
  constraints: flag('constraints', '不臆断未验证的事实；不把构建通过写成端到端通过'),
  // 引擎随登记一起上报：面板上谁用什么引擎、谁是真人在回，一眼可见
  engine: PROVIDER,
};

const RUNTIME_DIR = flag('runtime', path.join(process.cwd(), 'data', 'runner', AGENT));
const WORKDIR = flag('workdir', process.cwd());
const SANDBOX = flag('sandbox', 'read-only');
const MODEL = flag('model', process.env.DEEPSEEK_MODEL || 'deepseek-chat');

const withToken = (url) => (TOKEN ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(TOKEN)}` : url);
const log = (...parts) => {
  if (!QUIET) console.log(`[runner ${AGENT} ${new Date().toLocaleTimeString()}]`, ...parts);
};

async function call(apiPath, options) {
  const response = await fetch(withToken(`${BOARD}${apiPath}`), {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { ok: false, error: text };
  }
  if (!response.ok || (body && body.ok === false)) throw new Error(body?.error || response.statusText);
  return body;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 心跳/状态自报：失败不影响主流程（服务重启期间属于正常现象）。 */
async function heartbeat(state, note) {
  try {
    await call('/api/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ agent: AGENT, state, note, source: 'runner' }),
    });
  } catch (error) {
    log(`心跳上报失败（${state}）：${error.message}`);
  }
}

/* ── 提示词 ─────────────────────────────────────────────── */

// 当前正在生成的那一轮的取消句柄：控制指令（打断）通过它中止生成。
let activeAbort = null;

let busyReason = ''; // 生成期间向服务端自报的状态说明（续租用）

/** 生成期间的自报状态：既让面板显示「正在处理 #N」，也是续租的依据。 */
function busyNote(envelope) {
  return envelope ? `正在处理 #${envelope.seq}` : '正在处理点名';
}

function buildPrompt(envelope, recent) {
  const others = recent
    .filter((message) => message.seq !== envelope.seq)
    .slice(-8)
    .map((message) => `#${message.seq} [${message.agent}]${message.topic ? ` (${message.topic})` : ''} ${String(message.text).replace(/\s+/g, ' ').slice(0, 300)}`)
    .join('\n');

  return `你是本地协作黑板「Message Board」上的成员：${IDENTITY.name}（id: ${AGENT}）。
职位：${IDENTITY.title}。平台：${IDENTITY.platform}。
使命：${IDENTITY.mission}。
约束：${IDENTITY.constraints}。

黑板纪律（必须遵守）：
1. 只追加，不改写历史；回复要带结论、依据、下一步。
2. 区分事实与推断：事实给可复核证据，推断必须写明「推断」；不夸大状态（构建通过 ≠ 端到端通过）。
3. 不写密钥、令牌、Cookie。
4. 除非确实需要对方行动，否则不要在回复里 @ 别人（避免自动成员互相点名）。
5. 回复会被原样贴到黑板上，不要写「好的」「收到」这类空话，也不要复述本提示。

${others ? `黑板最近的留言：\n${others}\n` : ''}
现在有人点名你（#${envelope.seq}，来自 @${envelope.from}${envelope.topic ? `，议题 ${envelope.topic}` : ''}）：

"""${String(envelope.text).slice(0, 1200)}"""

请直接用中文写一条留言作为回复，先结论，再依据，最后下一步，控制在 400 字以内。`;
}

/* ── 引擎：Codex CLI 与 HTTP 两路都由 engines/ 承担，运行器只负责注册与调度 ── */


/** 引擎上下文：核心只提供事实（工作目录、沙箱、超时、身份），不替引擎做决定。 */
function engineContext(extra = {}) {
  return {
    agent: AGENT,
    identity: IDENTITY,
    workdir: WORKDIR,
    sandbox: SANDBOX,
    timeoutMs: TIMEOUT_MS,
    model: ENGINE_MODEL || MODEL,
    runtimeDir: RUNTIME_DIR,
    visible: VISIBLE,
    command: ENGINE_CMD,
    baseUrl: ENGINE_BASE_URL,
    apiKey: ENGINE_KEY,
    env: process.env,
    log,
    ...extra,
  };
}

/* ── 主循环 ─────────────────────────────────────────────── */

/** 回复写回失败时重试：服务重启、瞬时网络抖动都不该让回复凭空消失。 */
async function postMessage(payload, { attempts = 3, label = '留言' } = {}) {
  let lastError = null;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await call('/api/message', { method: 'POST', body: JSON.stringify(payload) });
    } catch (error) {
      lastError = error;
      log(`${label} 失败（第 ${i}/${attempts} 次）：${error.message}`);
      if (i < attempts) await new Promise((resolve) => setTimeout(resolve, 2000 * i));
    }
  }
  throw lastError;
}

async function handleWake(envelope) {
  const state = await call('/api/state?limit=12');
  const prompt = buildPrompt(envelope, state.messages || []);

  // 同一议题续接同一次对话（仅当引擎声明支持）：人类在黑板上的后续指令就是"接着同一场对话推进"
  const key = sessionKeyFor(envelope);
  const sessions = readSessions();
  const knownSession = RESUMABLE ? sessions[key] || '' : '';

  // 立刻回一条「处理中」通知：让点名的人看到反应，而不是干等 1–2 分钟。
  // 注意 kind=notice：服务端不会把它当成实质回应，「待回应」仍在。
  // human 引擎例外：没有"正在生成"这回事，发「处理中」反而误导，不如让它老实显示待回应。
  if (ACK && ENGINE_KIND !== 'human') {
    try {
      await call('/api/message', {
        method: 'POST',
        body: JSON.stringify({
          agent: AGENT,
          kind: 'notice',
          status: '进行中',
          topic: envelope.topic || null,
          replyTo: envelope.messageId,
          idempotencyKey: `${PROVIDER}:${envelope.messageId}:ack`,
          text: `已收到 #${envelope.seq} 的点名，正在用 ${PROVIDER} 生成实质回复（通常 30–120 秒）。本条为处理中通知，不是结论。`,
          client: { runner: PROVIDER, stage: 'ack' },
        }),
      });
    } catch (error) {
      log(`处理中通知发送失败（不影响后续回复）：${error.message}`);
    }
  }

  // 生成期间自报 state=busy：面板显示「正在处理 #N」，同时这是服务端给交付续租的依据。
  // 不报 busy 的话，一次超过 180 秒的生成会被误判成「超时未回」。
  const controller = new AbortController();
  activeAbort = controller;
  busyReason = busyNote(envelope);
  const ticker = setInterval(() => {
    void heartbeat('busy', busyReason);
  }, 30000);
  if (typeof ticker.unref === 'function') ticker.unref();
  await heartbeat('busy', busyReason);

  try {
    const result = await runEngine(
      PROVIDER,
      prompt,
      engineContext({ sessionId: knownSession, signal: controller.signal }),
    );
    const answer = result.text;
    const sessionId = result.sessionId || '';
    if (sessionId) {
      sessions[key] = sessionId;
      writeSessions(sessions);
    }
    const text = sessionId
      ? `${answer}\n\n（本次 Codex 会话：${sessionId}${knownSession ? '（续接同一议题的既有对话）' : ''} —— 终端执行 codex resume ${sessionId} 可进入同一次对话）`
      : answer;

    const posted = await postMessage(
      {
        agent: AGENT,
        text,
        kind: 'reply',
        topic: envelope.topic || null,
        status: '进行中',
        replyTo: envelope.messageId,
        idempotencyKey: `${PROVIDER}:${envelope.messageId}:reply`,
        client: { runner: PROVIDER, session: sessionId || null },
      },
      { label: '回复写回' },
    );
    log(`已回复 #${posted.message.seq}（回应 #${envelope.seq}）`);
    for (const warning of posted.warnings || []) log(`提示：${warning}`);
    return posted.message;
  } finally {
    clearInterval(ticker);
    if (activeAbort === controller) activeAbort = null;
    busyReason = '';
    await heartbeat('online', `运行器在线（${PROVIDER}）`);
  }
}

/* ── 控制指令与单轮处理 ─────────────────────────────────── */

/** 控制指令回执：打断是真的会中止当前生成，所以要先执行再回执。 */
async function handleControl(wake) {
  log(`收到控制指令：${wake.action}${wake.reason ? `（${wake.reason}）` : ''}`);
  const interrupted = wake.action === 'interrupt' && activeAbort;
  if (interrupted) {
    try {
      activeAbort.abort();
      log('已按控制指令中断当前生成');
    } catch {
      /* 忽略 */
    }
  }
  await postMessage(
    {
      agent: AGENT,
      kind: 'notice',
      status: '进行中',
      topic: null,
      idempotencyKey: `${PROVIDER}:control:${wake.at}`,
      text:
        wake.action === 'interrupt'
          ? interrupted
            ? '收到打断指令：已中止本轮生成（本条为回执，不是结论）。'
            : '收到打断指令：当前没有正在进行的生成，已记录（本条为回执）。'
          : `收到控制指令 ${wake.action}（本条为回执）。`,
      client: { runner: PROVIDER, control: wake.action },
    },
    { label: '控制回执' },
  ).catch(() => {});
}

/**
 * 跑一轮点名：生成期间仍然保持监听，所以打断指令能真的到达。
 * 生成期间新到的点名进 queued，由主循环接着处理 —— 不会被吞掉。
 */
async function runTurn(wake, queued) {
  const task = handleWake(wake).catch(async (error) => {
    // human 引擎：不生成、也不报错——点名保持"待回应"，等人来回复
    if (error.code === 'MANUAL' || String(error.message).startsWith('manual')) {
      log(`#${wake.seq} 交给人工处理（引擎 ${PROVIDER} 不自动回复），黑板上仍显示待回应`);
      return;
    }
    log(`处理失败：${error.message}`);
    const aborted = String(error.message).startsWith('aborted');
    try {
      await postMessage(
        {
          agent: AGENT,
          text: aborted
            ? `【${IDENTITY.name} 运行器】本轮生成已被打断指令中止，未产出结论。被中止的点名仍算未完成，需要重新点名或让我重做。`
            : `【${IDENTITY.name} 运行器】生成回复失败：${error.message}。本条为失败回执，不代表已完成。`,
          kind: 'notice',
          replyTo: wake.messageId,
          topic: wake.topic || null,
          status: aborted ? '已中止' : '阻塞',
        },
        { label: aborted ? '打断回执' : '失败回执' },
      );
    } catch (postError) {
      log(`回执也发不出去（服务可能不可用）：${postError.message}`);
    }
  });

  let done = false;
  void task.then(() => {
    done = true;
  });

  // 关键：生成（可能 30–180 秒）期间继续长轮询，否则 control 信封要等到本轮结束才被读到，
  // 打断就永远打不断。这里只处理控制指令，新点名排队。
  while (!done) {
    let polled;
    try {
      polled = await call(`/api/inbox?agent=${encodeURIComponent(AGENT)}&wait=3`);
    } catch {
      await sleep(2000);
      continue;
    }
    const next = polled.wake;
    if (!next) continue;
    if (next.type === 'control') await handleControl(next);
    else if (next.from !== AGENT) {
      log(`生成期间又收到点名 #${next.seq}，排到本轮之后处理`);
      queued.push(next);
    }
  }
  await task;
  return queued;
}

async function main() {
  // 加载外部引擎文件（可选）：第三方引擎不需要改核心
  for (const file of ENGINE_FILES) {
    try {
      const mod = await import(pathToFileURL(path.resolve(file)).href);
      const engine = mod.default || mod.engine || mod;
      const id = register(engine);
      log(`已从 ${file} 加载引擎「${id}」`);
    } catch (error) {
      log(`引擎文件加载失败（忽略）：${file} —— ${error.message}`);
    }
  }

  // 引擎先解析再登记：引擎写错就直接报清楚，不要变成一个"上线了但从不回话"的成员
  const engine = resolveEngine(PROVIDER);
  const health = await checkEngine(engine.meta.id, engineContext());
  log(`引擎：${engine.meta.id}（${engine.meta.label}）—— 自检 ${health.ok ? '通过' : '未通过'}：${health.detail}`);
  if (!health.ok) {
    log(`可用引擎：${listEngines().map((item) => item.id).join(', ')}`);
    log('继续启动，但提醒：自检未通过时点名可能没有回复。');
  }

  const joined = await call('/api/join', { method: 'POST', body: JSON.stringify(IDENTITY) });
  log(`已登记为「${joined.agent.name}」；引擎=${engine.meta.id}`);

  // 兜底：服务重启会清空内存里的唤醒队列，启动时补做最近一条未回应的点名
  if (CATCH_UP) {
    try {
      const state = await call('/api/state?limit=30');
      const mine = (state.pending || []).filter((item) => item.agent === AGENT);
      if (mine.length) {
        const newest = mine[mine.length - 1];
        log(`补做未回应的点名 #${newest.seq}（共 ${mine.length} 条待回应，只补最近一条）`);
        await handleWake({
          schema: 'messageboard.protocol.v1',
          type: 'mention',
          agent: AGENT,
          from: newest.from,
          messageId: newest.messageId,
          seq: newest.seq,
          topic: newest.topic,
          mentions: [AGENT],
          text: newest.excerpt,
          at: newest.at,
          board: BOARD,
          next: `读板 GET ${BOARD}/api/state?limit=50，并用 replyTo="${newest.messageId}" 给出实质回复`,
        });
      }
    } catch (error) {
      log(`补做检查失败（不影响监听）：${error.message}`);
    }
  }

  let turns = 0;
  const queued = []; // 生成期间新到的点名：本轮结束后接着处理，绝不丢

  for (;;) {
    try {
      await heartbeat('online', `运行器在线（${PROVIDER}）`);
      const result = await call(`/api/inbox?agent=${encodeURIComponent(AGENT)}&wait=${WAIT_SECONDS}`);
      // 先区分信封类型：control（打断等控制指令）**不是**点名，
      // 它没有 seq/正文；当成点名会让模型看到一堆 undefined（实测踩过）。
      if (result.wake && result.wake.type === 'control') {
        await handleControl(result.wake);
      } else if (result.wake && result.wake.from !== AGENT) {
        log(`被 @${result.wake.from} 点名（#${result.wake.seq}），唤起 ${PROVIDER}…`);
        await runTurn(result.wake, queued);
        turns += 1;
        if (ONCE || (MAX_TURNS > 0 && turns >= MAX_TURNS)) {
          log(`已达到 ${ONCE ? '--once' : `--max-turns ${MAX_TURNS}`} 限制，退出。`);
          return;
        }
      } else if (queued.length) {
        const next = queued.shift();
        log(`处理生成期间积压的点名 #${next.seq}`);
        await runTurn(next, queued);
        turns += 1;
      }
    } catch (error) {
      log(`监听异常：${error.message}`);
      await sleep(3000);
    }
  }
}

main().catch((error) => {
  console.error(`运行器失败：${error.message}`);
  process.exitCode = 1;
});
