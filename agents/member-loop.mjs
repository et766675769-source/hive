#!/usr/bin/env node
// Message Board · 通用成员循环（vendor-neutral member loop）
//
// 它负责**协议**，不负责"思考"：
//   心跳（在线判定） + 长轮询（即时唤醒） + 忙碌自报（长任务不被误判丢失）
//   + 幂等回复（重试不刷重复） + 丢失上报（重启后立即重投） + 退避重连
// "思考"交给外部命令：命令从 stdin 收到 JSON（点名信封 + 最近留言），把回复正文打到 stdout。
//
// 用法：
//   node agents/member-loop.mjs --agent workbuddy --reply-cmd "your-ai-cli --stdin"
//   node agents/member-loop.mjs --agent workbuddy --reply-cmd "node agents/example-reply.mjs"
//
// 常用参数：
//   --board <url>     黑板地址，默认 http://127.0.0.1:8787
//   --name/--title    报到时显示的身份（省略则用默认值）
//   --wait <秒>       空闲时长轮询等待，默认 25（处理中自动降到 5，保证心跳不断）
//   --timeout <秒>    单次思考命令超时，默认 420
//   --once            处理一条点名后退出（交给外部调度器保活时用）
//
// 思考命令怎么传（Windows 上引号很容易被拆坏，按可靠性排序）：
//   1) 环境变量 MB_REPLY_CMD="your-ai-cli --stdin"        ← 最稳，推荐
//   2) --reply-cmd-file path\to\reply-cmd.txt              ← 文件里写一整行命令
//   3) --reply-cmd="your-ai-cli --stdin"                   ← 直接传（注意整体加引号）
//
// 这套循环就是提示词里"稳定运行方法"的可执行版本；也可以只当参考实现抄。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runEngine, resolveEngine, checkEngine } from '../engines/registry.mjs';

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
const AGENT = String(flag('agent', '')).toLowerCase();

/**
 * 解析"思考命令"。三种来源按可靠性排序：环境变量 > 命令文件 > 直接参数。
 * 之所以要前两种：Windows 上把带空格的命令当参数传，很容易被 shell/调度器拆坏
 * （实测 --reply-cmd "node agents/example-reply.mjs" 会被截成 "node"）。
 */
function resolveReplyCommand() {
  if (process.env.MB_REPLY_CMD) return process.env.MB_REPLY_CMD.trim();
  const file = flag('reply-cmd-file');
  if (file) {
    try {
      const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)[0].trim();
      if (text) return text;
    } catch (error) {
      console.error(`读取 --reply-cmd-file 失败：${error.message}`);
    }
  }
  return String(flag('reply-cmd', '')).trim();
}

const REPLY_CMD = resolveReplyCommand();
// --engine 优先：引擎是可替换插槽，命令只是"其中一种引擎"的老写法
const ENGINE = String(flag('engine') || process.env.MB_ENGINE || '').trim().toLowerCase();
// 默认先回执（契约的第一半）；带 --no-ack 可关
const ACK = !args.includes('--no-ack');
// 默认启动补做：登记之前发出的点名，长轮询永远等不到，必须自己读一次
const CATCH_UP = !args.includes('--no-catch-up');
const CATCH_UP_LIMIT = Math.max(1, Number(flag('catch-up-limit', 3)));
const WAIT_IDLE = Math.max(5, Math.min(Number(flag('wait', 25)), 60));
const WAIT_BUSY = 5;
const REPLY_TIMEOUT_MS = Math.max(30, Number(flag('timeout', 420))) * 1000;
const ONCE = args.includes('--once');
const QUIET = args.includes('--quiet');

if (!AGENT || (!REPLY_CMD && !ENGINE)) {
  console.error('用法：node agents/member-loop.mjs --agent <id> --engine <引擎 id>');
  console.error('  或：node agents/member-loop.mjs --agent <id> --reply-cmd "<命令>"');
  console.error('  可用引擎：rule-based / command / openai-compatible / codex-cli / human');
  process.exit(2);
}
if (ENGINE) {
  try {
    resolveEngine(ENGINE);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}

const RUNTIME_DIR = flag('runtime', path.join(process.cwd(), 'data', 'runner', AGENT));
const JOURNAL = () => path.join(RUNTIME_DIR, 'journal.json');
const log = (...parts) => {
  if (!QUIET) console.log(`[member-loop ${new Date().toLocaleTimeString()} ${AGENT}]`, ...parts);
};

/* ── 黑板接口 ───────────────────────────────────────────── */

async function call(apiPath, options = {}) {
  const response = await fetch(`${BOARD}${apiPath}`, {
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(options.timeoutMs || 40000),
    ...options,
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { ok: false, error: text };
  }
  if (!response.ok || (body && body.ok === false)) throw new Error(body?.error || response.statusText);
  return body;
}

const heartbeat = (state, note) =>
  call('/api/heartbeat', { method: 'POST', body: JSON.stringify({ agent: AGENT, state, note }) }).catch((error) => {
    log(`心跳失败：${error.message}`);
  });

/** 回复写回黑板：带幂等键，重试不会刷出重复留言。 */
async function postReply(envelope, text, kind = 'reply', client = {}) {
  const key = `member-loop:${envelope?.messageId || 'notice'}:${kind}`;
  // 状态措辞要跟内容一致：回执和回复都是"进行中"，只有失败/无法完成才是"阻塞"。
  // 回执写成"阻塞"会让人误以为这条已经卡住了。
  const status = kind === 'reply' || client.stage === 'ack' ? '进行中' : '阻塞';
  return call('/api/message', {
    method: 'POST',
    body: JSON.stringify({
      agent: AGENT,
      text,
      kind,
      topic: envelope?.topic || null,
      status,
      replyTo: envelope?.messageId || null,
      idempotencyKey: key,
      client: { channel: 'member-loop', ...client },
    }),
  });
}

/**
 * 报到留言 = 接入自检表（提示词第 4 步要求）。
 * 用 member-loop 的成员不必自己拼这张表：它知道自己这一侧的事实，如实写出来即可。
 * 幂等键固定，重启不会重复贴。
 */
async function postSelfCheck(identity) {
  const state = await call('/api/state?limit=1').catch(() => null);
  const lines = [
    `接入自检表（${identity.name}）`,
    '',
    '| 检查项 | 结果 |',
    '| --- | --- |',
    `| 黑板探活 /api/health | 通过（${BOARD}） |`,
    `| 身份登记 /api/join | 通过（id=${AGENT}） |`,
    `| 唤醒通道 | 长轮询 /api/inbox（wait=${WAIT_IDLE}s，处理中降到 ${WAIT_BUSY}s 保心跳） |`,
    `| 能否收到点名 | 能：收到后由外部命令产出回复并按 replyTo 回写 |`,
    `| 我的网络是否需要代理 | 不需要（本机回环直连）${process.env.HTTPS_PROXY ? `；外部调用用 ${process.env.HTTPS_PROXY}` : ''} |`,
    `| 我承诺的回应方式 | 被 @ 后立即回实质内容；长任务期间自报 busy，完成回落 online |`,
    `| 思考命令 | ${REPLY_CMD} |`,
    `| 当前黑板 | 最新 #${state?.stats?.latestSeq ?? '—'}，成员 ${state?.agents?.length ?? '—'} 个 |`,
  ];
  return call('/api/message', {
    method: 'POST',
    body: JSON.stringify({
      agent: AGENT,
      kind: 'notice',
      status: '进行中',
      text: lines.join('\n'),
      idempotencyKey: `member-loop:${AGENT}:selfcheck`,
      client: { channel: 'member-loop', selfCheck: true },
    }),
  });
}

/* ── 在跑的那一轮：落盘 journal，供重启后上报丢失 ───────── */

function writeJournal(record) {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(JOURNAL(), JSON.stringify(record, null, 2), 'utf8');
  } catch (error) {
    log(`journal 落盘失败：${error.message}`);
  }
}
const clearJournal = () => {
  try {
    fs.rmSync(JOURNAL(), { force: true });
  } catch {
    /* 忽略 */
  }
};
function readJournal() {
  try {
    return JSON.parse(fs.readFileSync(JOURNAL(), 'utf8'));
  } catch {
    return null;
  }
}

/* ── 把"思考"交给引擎（engine）或外部命令 ─────────────────── */

/**
 * 引擎优先，命令兜底：
 *   --engine <id>  用 engines/registry.mjs 里的引擎（rule-based / command /
 *                  openai-compatible / codex-cli / human），跨平台且能自检；
 *   --reply-cmd    直接给一条命令（老用法，仍然完全支持）。
 * 两条路都遵守同一个约定：提示词进、答复出，成员身份与写入黑板由本循环负责。
 */
function replyPrompt(envelope, recent) {
  const others = recent
    .filter((message) => message.seq !== envelope.seq)
    .map((message) => `#${message.seq} [${message.agent}]${message.topic ? ` (${message.topic})` : ''} ${String(message.text).replace(/\s+/g, ' ').slice(0, 300)}`)
    .join('\n');
  return `你是本地协作黑板「Message Board」上的成员：${IDENTITY.name}（id: ${AGENT}）。
职位：${IDENTITY.title}。使命：${IDENTITY.mission}。

黑板纪律（必须遵守）：
1. 只追加，不改写历史；回复要带结论、依据、下一步。
2. 区分事实与推断：事实给可复核证据，推断必须写明「推断」；不夸大状态（构建通过 ≠ 端到端通过）。
3. 不写密钥、令牌、Cookie。
4. 除非确实需要对方行动，否则不要在回复里 @ 别人。
5. 回复会被原样贴到黑板上，不要写「好的」「收到」这类空话，也不要复述本提示。
6. **不要自己调用黑板接口发言**：把留言正文作为你的最终输出返回即可，
   本循环会替你写回黑板并带上正确的 replyTo。自己再发一遍会产生重复留言，
   而且在 Windows 控制台里用 curl 发中文会把编码变成问号。

${others ? `黑板最近的留言：\n${others}\n` : ''}
现在有人点名你（#${envelope.seq}，来自 @${envelope.from}${envelope.topic ? `，议题 ${envelope.topic}` : ''}）：

"""${String(envelope.text).slice(0, 1200)}"""

请直接用中文写一条留言作为回复，先结论，再依据，最后下一步，控制在 400 字以内。`;
}

function runReplyCommand(envelope, recent) {
  return new Promise((resolve, reject) => {
    const child = spawn(REPLY_CMD, { shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
      reject(new Error(`思考命令超时（${REPLY_TIMEOUT_MS / 1000}s）`));
    }, REPLY_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) resolve(stdout.trim());
      else reject(new Error(`思考命令退出码 ${code}${stderr.trim() ? `：${stderr.trim().slice(0, 300)}` : ''}`));
    });

    // 命令从 stdin 拿到：点名信封 + 黑板最近的留言（用于上下文）
    child.stdin.end(JSON.stringify({ envelope, recent }, null, 2));
  });
}

/** 统一入口：有 --engine 就走引擎，否则走 --reply-cmd。 */
async function think(envelope, recent) {
  if (!ENGINE) return runReplyCommand(envelope, recent);
  const result = await runEngine(ENGINE, replyPrompt(envelope, recent), {
    agent: AGENT,
    identity: IDENTITY,
    timeoutMs: REPLY_TIMEOUT_MS,
    runtimeDir: RUNTIME_DIR,
    log,
  });
  return result.text;
}

/* ── 处理一条点名 ───────────────────────────────────────── */

async function handleMention(envelope) {
  log(`收到点名 #${envelope.seq}（来自 @${envelope.from}）`);
  writeJournal({ messageId: envelope.messageId, seq: envelope.seq, topic: envelope.topic || null, startedAt: new Date().toISOString() });

  // 契约的第一半：先回执说"我开始了"。没有这一步，面板上会一直停在
  // 「已送达，等回执」，超过 ackTimeoutSeconds 就变成「没回执（未开始）」——
  // 而哨兵会把它当成违约去报告和接管。回执不是结论，kind=notice 不计入交付。
  if (ACK) {
    await postReply(
      envelope,
      `已收到 #${envelope.seq} 的点名，正在处理。本条为回执（不是结论），结果稍后按 replyTo 写回。`,
      'notice',
      { stage: 'ack' },
    ).catch((error) => log(`回执发送失败（不影响后续回复）：${error.message}`));
  }

  await heartbeat('busy', `正在处理 #${envelope.seq}`);

  try {
    const state = await call('/api/state?limit=20');
    const text = await think(envelope, (state.messages || []).slice(-10));
    const posted = await postReply(envelope, text, 'reply', { seq: envelope.seq });
    log(`已回复 #${posted.message.seq}`);
  } catch (error) {
    log(`这一轮失败：${error.message}`);
    // 失败要说清楚是"我丢了这轮"（aborted → 黑板立即重投）还是"我给不出答案"（notice）。
    const infra = /超时|退出码|ENOENT|spawn/.test(error.message);
    await postReply(
      envelope,
      infra
        ? `我这轮没跑完（${error.message}），已请求黑板立即重投，不需要等租约到期。`
        : `我无法完成这条指名：#${envelope.seq}。原因：${error.message}`,
      'notice',
      infra ? { aborted: true } : { failed: true },
    ).catch((postError) => log(`失败回执也没发出去：${postError.message}`));
  } finally {
    clearJournal();
    await heartbeat('online', '空闲');
  }
}

async function handleControl(control) {
  log(`收到控制指令：${control.action}${control.reason ? `（${control.reason}）` : ''}`);
  await postReply(
    null,
    control.action === 'interrupt'
      ? '收到打断指令：本轮已按要求中止（本条为回执）。'
      : `收到控制指令 ${control.action}，当前实现不做处理。`,
    'notice',
    { control: control.action },
  ).catch(() => {});
}

/* ── 身份 ───────────────────────────────────────────────── */

// 身份必须是模块级的：提示词（replyPrompt）与登记（main）都要用它。
// 之前它只在 main() 里定义，于是 --engine 模式下提示词一引用就抛
// "IDENTITY is not defined"——一个刚接入的成员第一次被点名就回了一句报错（实测踩过，
// 而且是在"照抄一条命令的笨成员"验收里抓到的）。
const IDENTITY = {
  agent: AGENT,
  name: flag('name', AGENT),
  title: flag('title', '成员'),
  platform: flag('platform', 'member-loop'),
  mission: flag('mission', '按提示词接入并交付'),
  skills: flag('skills', ''),
  constraints: flag('constraints', ''),
};

/* ── 主循环 ─────────────────────────────────────────────── */

async function main() {
  const identity = IDENTITY;
  await call('/api/join', { method: 'POST', body: JSON.stringify(identity) });
  log(ENGINE ? `已登记；引擎=${ENGINE}` : `已登记；思考命令：${REPLY_CMD}`);
  if (!ENGINE && !REPLY_CMD) log('警告：既没有 --engine 也没有 --reply-cmd，被点名时无法产出回复。');

  // 报到留言：接入自检表（提示词第 4 步要求的交付物）。幂等，重启不会重复贴。
  await postSelfCheck(identity)
    .then((posted) => log(posted?.duplicate ? '自检表已存在（未重复贴）' : `已贴出接入自检表 #${posted?.message?.seq}`))
    .catch((error) => log(`自检表贴出失败：${error.message}`));

  // 上次运行时被重启/杀掉 → 立即上报丢失，让黑板马上重投
  const lost = readJournal();
  if (lost && lost.messageId) {
    log(`发现上次未完成的 #${lost.seq}，上报丢失并请求重投`);
    await postReply(
      lost,
      `我的进程上次被中断：#${lost.seq} 没跑完，已请求黑板立即重投。本条为基础设施丢失回执。`,
      'notice',
      { aborted: true },
    ).catch((error) => log(`上报失败：${error.message}`));
  }
  clearJournal();

  // 启动补做：这是"笨成员"路上最关键的一步。
  // 点名如果在你登记**之前**发出，那一刻你不在名册、唤醒队列里没有你——
  // 之后你挂上长轮询也永远等不到它，面板就会显示"在线却不回话"（实测就是这个：
  // 照抄 serve 的成员登记完就干等，pending 一直挂着）。所以启动先读一次自己的待回应。
  if (CATCH_UP) {
    try {
      const state = await call('/api/state?limit=50');
      const mine = (state.pending || []).filter((item) => item.agent === AGENT);
      if (mine.length) {
        const targets = mine.slice(0, CATCH_UP_LIMIT);
        log(`补做 ${targets.length} 条未回应的点名（共 ${mine.length} 条，上限 ${CATCH_UP_LIMIT}）：#${targets.map((item) => item.seq).join(', #')}`);
        for (const item of targets) {
          await handleMention({
            schema: 'messageboard.protocol.v1',
            type: 'mention',
            agent: AGENT,
            from: item.from,
            messageId: item.messageId,
            seq: item.seq,
            topic: item.topic,
            mentions: [AGENT],
            text: item.excerpt,
            at: item.at,
            board: BOARD,
            next: `读板并用 replyTo="${item.messageId}" 给出实质回复`,
          });
        }
      }
    } catch (error) {
      log(`补做检查失败（不影响监听）：${error.message}`);
    }
  }

  let backoff = 1000;
  for (;;) {
    try {
      await heartbeat('online', '空闲');
      const result = await call(`/api/inbox?agent=${encodeURIComponent(AGENT)}&wait=${WAIT_IDLE}`, {
        timeoutMs: (WAIT_IDLE + 15) * 1000,
      });
      backoff = 1000; // 成功一次就重置退避
      if (result.wake?.type === 'control') {
        await handleControl(result.wake);
      } else if (result.wake && result.wake.from !== AGENT) {
        await handleMention(result.wake);
        if (ONCE) {
          log('--once：处理完一条，退出');
          return;
        }
      }
    } catch (error) {
      log(`循环异常：${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, backoff));
      backoff = Math.min(backoff * 2, 30000);
    }
  }
}

main().catch((error) => {
  console.error(`member-loop 失败：${error.message}`);
  process.exitCode = 1;
});
