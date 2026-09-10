#!/usr/bin/env node
// Message Board · 成员运行器
//
// 把「被点名」变成「真的回应」：常驻监听黑板，一被 @ 就唤起背后的 agent，
// 把它的答复作为该成员的留言写回黑板（带 replyTo）。
//
// 支持的 provider：
//   codex-cli     本机 Codex CLI：codex exec -o <文件> "<提示>"（不依赖 stdout 管道）
//   deepseek-api  调用 DeepSeek Chat Completions（密钥取自环境变量或 dsh 凭证）
//
// 用法：
//   node bridges/agent-runner.js --agent codex --provider codex-cli \
//        --name Codex --title "项目主 Agent" --workdir "D:\some\repo" --sandbox read-only
//
//   node bridges/agent-runner.js --agent deepseek --provider deepseek-api --model deepseek-chat
//
// 安全与纪律：
//   - 只回应「点名自己」的留言；自己发的留言、以及没有点自己的留言都不回应；
//   - `--max-turns` 限制本次进程最多回几条，避免两个自动成员互相点名刷屏；
//   - prompt 里明确要求「非必要不要 @ 别人」；
//   - 回复同样是普通留言：立刻被写入黑板，遵守只追加与状态措辞纪律。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

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
const PROVIDER = flag('provider', 'deepseek-api');
const WAIT_SECONDS = Math.max(5, Math.min(Number(flag('wait', 25)), 60));
const MAX_TURNS = Number(flag('max-turns', 5));
const TIMEOUT_MS = Number(flag('timeout', 420)) * 1000;
const ONCE = args.includes('--once');
const QUIET = args.includes('--quiet');
// 默认开启：收到点名先回一条「处理中」通知，让点名者看得见反应
const ACK = !args.includes('--no-ack');
// 默认开启：启动时补做最近一条未回应的点名（服务重启会清空内存队列，靠它兜底）
const CATCH_UP = !args.includes('--no-catch-up');
// codex-cli：把这次会话开在一个独立终端窗口里，人能看见"新对话正在跑"
const VISIBLE = args.includes('--visible');

const SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');

/* ── 议题 → Codex 会话：同一议题的后续点名续接同一次对话 ── */

const SESSIONS_FILE = path.join(RUNTIME_DIR, 'sessions.json');

function readSessions() {
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeSessions(map) {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(map, null, 2), 'utf8');
  } catch (error) {
    log(`会话表保存失败：${error.message}`);
  }
}

/** 议题（没有议题就用 __default__）→ 会话 id */
function sessionKeyFor(envelope) {
  return envelope.topic || '__default__';
}

/** 取最近一次 Codex 会话 id（rollout 文件名里带 uuid），用于回报可 resume 的会话。 */
function findLatestSessionId(sinceMs) {
  try {
    let newest = null;
    const walk = (dir, depth = 0) => {
      if (depth > 4) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.name.endsWith('.jsonl')) {
          const stat = fs.statSync(full);
          if (stat.mtimeMs >= sinceMs - 2000 && (!newest || stat.mtimeMs > newest.mtimeMs)) {
            newest = { mtimeMs: stat.mtimeMs, name: entry.name };
          }
        }
      }
    };
    if (fs.existsSync(SESSIONS_DIR)) walk(SESSIONS_DIR);
    if (!newest) return '';
    const match = newest.name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

if (!AGENT) {
  console.error('缺少 --agent <id>，例如 --agent codex');
  process.exit(1);
}

const IDENTITY = {
  id: AGENT,
  name: flag('name', AGENT),
  title: flag('title', '成员'),
  platform: flag('platform', PROVIDER === 'codex-cli' ? 'Codex CLI' : 'DeepSeek API'),
  mission: flag('mission', '按黑板上的点名为同伴提供可核验的答复'),
  skills: flag('skills', ''),
  constraints: flag('constraints', '不臆断未验证的事实；不把构建通过写成端到端通过'),
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

/* ── 提示词 ─────────────────────────────────────────────── */

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

/* ── provider: codex-cli ────────────────────────────────── */

function q(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function runCodex(prompt, { sessionId = '' } = {}) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    const stamp = Date.now();
    const promptFile = path.join(RUNTIME_DIR, `prompt-${stamp}.txt`);
    const outFile = path.join(RUNTIME_DIR, `last-${stamp}.txt`);
    fs.writeFileSync(promptFile, prompt, 'utf8');

    // 提示词从文件重定向进 stdin（命令行保持很短，且不依赖 stdout 管道）；
    // 回复由 codex 的 -o 写到文件，读文件即可，全程不开命名管道。
    // disk-full-read-access：让 Codex 能读盘上其它目录（例如 obsidian 仓库），写仍然受会话沙箱限制。
    // 给了 sessionId 就走 exec resume —— 同一个议题的后续点名会在同一场对话里继续。
    const head = ['codex', 'exec'];
    const tail = [
      '--skip-git-repo-check',
      '-c',
      'sandbox_permissions=["disk-full-read-access"]',
    ];
    if (sessionId) {
      head.push('resume');
      tail.push('-o', q(outFile), sessionId, '-', '<', q(promptFile));
      log(`续接 Codex 会话 ${sessionId}（同一议题继续同一次对话）`);
    } else {
      tail.push('-C', q(WORKDIR), '-s', SANDBOX, '-o', q(outFile), '-', '<', q(promptFile));
    }
    const command = [...head, ...tail].join(' ');
    log(`调用 codex exec（sandbox=${SANDBOX}, cwd=${WORKDIR}${VISIBLE ? ', 独立窗口' : ''}）`);

    const startedAt = Date.now();
    let child;
    if (VISIBLE) {
      // 独立终端窗口里跑：你能看到「新对话正在执行」，会话结束后窗口保留几秒
      const batch = path.join(RUNTIME_DIR, `run-${stamp}.cmd`);
      fs.writeFileSync(
        batch,
        `@echo off\r\ntitle Message Board - ${IDENTITY.name}\r\n${command}\r\necho.\r\necho ---- codex exit %errorlevel% ----\r\nping -n 9 127.0.0.1 >nul\r\n`,
        'ascii',
      );
      child = spawn('cmd.exe', ['/c', 'start', '/wait', '', batch], {
        cwd: WORKDIR,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } else {
      child = spawn(command, {
        cwd: WORKDIR,
        shell: true,
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
      });
    }

    // 完成判定以「-o 输出文件写稳」为准，而不是进程退出：
    // 可见窗口模式下的 start/wait 包装、或 codex 结束后仍在收尾，都可能让进程迟迟不退。
    let settled = false;
    let lastSeen = '';
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poller);
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
      if (error) reject(error);
      else resolve(value);
    };

    const readOut = () => {
      try {
        if (!fs.existsSync(outFile)) return '';
        return fs.readFileSync(outFile, 'utf8').trim();
      } catch {
        return '';
      }
    };
    const done = (text) => {
      const sessionId = findLatestSessionId(startedAt);
      if (sessionId) log(`本次会话 id：${sessionId}  （可在终端执行 codex resume ${sessionId} 进入）`);
      settle(null, { text: text || '（codex 返回了空回复）', sessionId });
    };

    const poller = setInterval(() => {
      const text = readOut();
      if (!text) return;
      if (text === lastSeen) done(text); // 连续两次读到同样内容 = 已写完
      else lastSeen = text;
    }, 1500);
    if (typeof poller.unref === 'function') poller.unref();

    const timer = setTimeout(() => {
      const text = readOut();
      if (text) {
        log('进程未退出，但已读到完整回复，按成功处理');
        done(text);
        return;
      }
      settle(new Error(`codex exec 超时（${TIMEOUT_MS / 1000}s），且没有产生输出文件`));
    }, TIMEOUT_MS);

    child.on('error', (error) => settle(error));
    child.on('exit', () => {
      const text = readOut();
      if (text) done(text);
      else settle(new Error('codex exec 已退出，但没有产生 -o 输出文件'));
    });
  });
}

/* ── provider: deepseek-api ─────────────────────────────── */

function readDeepSeekKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  const candidates = [
    path.join(process.env.APPDATA || '', 'dsh-desktop-home', '.credentials.yaml'),
    path.join(os.homedir(), '.dsh', '.credentials.yaml'),
  ];
  for (const file of candidates) {
    try {
      const match = fs.readFileSync(file, 'utf8').match(/^\s*DEEPSEEK_API_KEY\s*:\s*(\S+)\s*$/m);
      if (match) return match[1].trim().replace(/^["']|["']$/g, '');
    } catch {
      /* 继续找下一个 */
    }
  }
  return '';
}

async function runDeepSeek(prompt) {
  const key = readDeepSeekKey();
  if (!key) throw new Error('找不到 DEEPSEEK_API_KEY（环境变量或 dsh 凭证文件）');
  const response = await fetch(process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: `你是黑板成员 ${IDENTITY.name}（id: ${AGENT}），${IDENTITY.title}。直接给出可核验的答复。` },
        { role: 'user', content: prompt },
      ],
      max_tokens: 900,
      temperature: 0.3,
      stream: false,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`DeepSeek API ${response.status}：${(await response.text()).slice(0, 200)}`);
  }
  const body = await response.json();
  return (body?.choices?.[0]?.message?.content || '').trim() || '（模型返回了空回复）';
}

const PROVIDERS = { 'codex-cli': runCodex, 'deepseek-api': runDeepSeek };

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

  // 同一议题续接同一次 Codex 对话：这样人类在黑板上的后续指令就是"接着同一场对话推进"
  const key = sessionKeyFor(envelope);
  const sessions = readSessions();
  const knownSession = PROVIDER === 'codex-cli' ? sessions[key] || '' : '';

  // 立刻回一条「处理中」通知：让点名的人看到反应，而不是干等 1–2 分钟。
  // 注意 kind=notice：服务端不会把它当成实质回应，「待回应」仍在。
  if (ACK) {
    try {
      await call('/api/message', {
        method: 'POST',
        body: JSON.stringify({
          agent: AGENT,
          kind: 'notice',
          status: '进行中',
          topic: envelope.topic || null,
          replyTo: envelope.messageId,
          text: `已收到 #${envelope.seq} 的点名，正在用 ${PROVIDER} 生成实质回复（通常 30–120 秒）。本条为处理中通知，不是结论。`,
          client: { runner: PROVIDER, stage: 'ack' },
        }),
      });
    } catch (error) {
      log(`处理中通知发送失败（不影响后续回复）：${error.message}`);
    }
  }

  const result = await (PROVIDERS[PROVIDER] || runDeepSeek)(prompt, { sessionId: knownSession });
  const answer = typeof result === 'string' ? result : result.text;
  const sessionId = typeof result === 'string' ? '' : result.sessionId || '';
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
      client: { runner: PROVIDER, session: sessionId || null },
    },
    { label: '回复写回' },
  );
  log(`已回复 #${posted.message.seq}（回应 #${envelope.seq}）`);
  for (const warning of posted.warnings || []) log(`提示：${warning}`);
  return posted.message;
}

async function main() {
  const joined = await call('/api/join', { method: 'POST', body: JSON.stringify(IDENTITY) });
  log(`已登记为「${joined.agent.name}」；provider=${PROVIDER}`);

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
  for (;;) {
    try {
      await call('/api/heartbeat', {
        method: 'POST',
        body: JSON.stringify({ agent: AGENT, state: 'online', note: `运行器在线（${PROVIDER}）` }),
      });
      const result = await call(`/api/inbox?agent=${encodeURIComponent(AGENT)}&wait=${WAIT_SECONDS}`);
      if (result.wake && result.wake.from !== AGENT) {
        log(`被 @${result.wake.from} 点名（#${result.wake.seq}），唤起 ${PROVIDER}…`);
        try {
          await handleWake(result.wake);
        } catch (error) {
          log(`处理失败：${error.message}`);
          try {
            await postMessage(
              {
                agent: AGENT,
                text: `【${IDENTITY.name} 运行器】生成回复失败：${error.message}。本条为失败回执，不代表已完成。`,
                kind: 'notice',
                replyTo: result.wake.messageId,
                topic: result.wake.topic || null,
                status: '阻塞',
              },
              { label: '失败回执' },
            );
          } catch (postError) {
            log(`失败回执也发不出去（服务可能不可用）：${postError.message}`);
          }
        }
        turns += 1;
        if (ONCE || (MAX_TURNS > 0 && turns >= MAX_TURNS)) {
          log(`已达到 ${ONCE ? '--once' : `--max-turns ${MAX_TURNS}`} 限制，退出。`);
          return;
        }
      }
    } catch (error) {
      log(`监听异常：${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

main().catch((error) => {
  console.error(`运行器失败：${error.message}`);
  process.exitCode = 1;
});
