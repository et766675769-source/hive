#!/usr/bin/env node
// Message Board · Codex 通道（app-server / JSON-RPC 2.0）
//
// 为什么不用 `codex exec`：那是"一次性 CLI + 刮输出文件"，每次冷启动、靠进程退出判断完成、
// 拿不到流式过程、也没法中途干预。本通道改用 Codex 自己的 harness 接口：
//
//   codex app-server --listen stdio://        （JSON-RPC 2.0，行分隔 JSON）
//     initialize / initialized                握手
//     thread/start | thread/resume            一次真实的 Codex 对话（有 thread id，可在 Codex 里打开）
//     turn/start                              发起一轮
//     turn/steer                              往"正在跑"的这一轮里插话  ← 中途控制
//     turn/interrupt                          中断本轮
//   事件：thread/started、turn/started、item/started、item/agentMessage/delta、
//         item/completed、turn/completed、error(-32001 过载可退避重试)
//
// 与黑板的结合点：
//   - 黑板长轮询 /api/inbox 拿到点名 → 同一议题复用同一 thread（thread/resume），否则新建
//   - 正在跑 turn 时又来点名 → 用 turn/steer 插进当前这一轮，而不是另起一轮
//   - turn/completed 拿到最终消息 → 作为该成员的回复写回黑板（带 replyTo）
//
// 用法：
//   node bridges/codex-channel.js --agent codex --workdir "D:\DS harkness\MessageBoard"

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';

import { stripBom } from '../server/protocol.js';

/**
 * 找出本机应给 Codex 用的 HTTP 代理。
 * 背景：Windows 的"系统代理"设置（注册表 Internet Settings）很多 CLI 并不读取，
 * Codex 的 HTTP 客户端只看环境变量，于是直连 chatgpt.com 会超时并退避重连 5 次，
 * 白白多花 60–90 秒。这里把系统代理读出来喂给它。
 */
function detectProxy() {
  const explicit = flag('proxy');
  if (explicit === 'off' || explicit === 'none') return '';
  if (explicit) return explicit;
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    const value = process.env[name];
    if (value) return value;
  }
  if (process.platform !== 'win32') return '';
  try {
    const out = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const match = out.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
    if (!match) return '';
    const raw = match[1].trim();
    const value = /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`;
    return value;
  } catch {
    return '';
  }
}

/* ── 参数 ───────────────────────────────────────────────── */

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
const AGENT = String(flag('agent', 'codex')).toLowerCase();
const WORKDIR = flag('workdir', process.cwd());
const WAIT_SECONDS = Math.max(5, Math.min(Number(flag('wait', 25)), 60));
const QUIET = args.includes('--quiet');
// 默认关掉 responses 的 WebSocket 传输：本机到 wss://chatgpt.com/... 的链路不通，
// Codex 会先退避重连 5 次（每次约 15s）再回落 HTTPS，白白多花 60–90 秒。
// 需要时用 --ws 打开。
const USE_WS = args.includes('--ws');

const IDENTITY = {
  id: AGENT,
  name: flag('name', 'Codex'),
  title: flag('title', '项目主 Agent'),
  platform: flag('platform', 'Codex app-server'),
  mission: flag('mission', '目标拆解、代码实现、事实核验与最终技术决策'),
  skills: flag('skills', '长上下文编码与重构、测试与验证'),
  constraints: flag('constraints', '不臆断未验证的事实；不把构建通过写成端到端通过'),
};

const RUNTIME_DIR = flag('runtime', path.join(process.cwd(), 'data', 'runner', AGENT));
const THREADS_FILE = () => path.join(RUNTIME_DIR, 'threads.json');
const PROXY = detectProxy();

const log = (...parts) => {
  if (!QUIET) console.log(`[codex-channel ${new Date().toLocaleTimeString()}]`, ...parts);
};

function readThreads() {
  try {
    return JSON.parse(stripBom(fs.readFileSync(THREADS_FILE(), 'utf8')));
  } catch {
    return {};
  }
}

function writeThreads(map) {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(THREADS_FILE(), JSON.stringify(map, null, 2), 'utf8');
  } catch (error) {
    log(`threads 落盘失败：${error.message}`);
  }
}

/* ── 黑板接口 ───────────────────────────────────────────── */

const withToken = (url) => (TOKEN ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(TOKEN)}` : url);

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

/** 回复写回黑板：失败重试，别让成品凭空消失。 */
async function postBoard(payload, { attempts = 3, label = '留言' } = {}) {
  let lastError = null;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await call('/api/message', { method: 'POST', body: JSON.stringify(payload) });
    } catch (error) {
      lastError = error;
      log(`${label}失败（${i}/${attempts}）：${error.message}`);
      if (i < attempts) await new Promise((resolve) => setTimeout(resolve, 1500 * i));
    }
  }
  throw lastError;
}

/* ── app-server 通道 ────────────────────────────────────── */

class CodexChannel {
  constructor({ cwd }) {
    this.cwd = cwd;
    this.child = null;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Set();
    this.buffer = '';
    this.ready = false;
  }

  onEvent(handler) {
    this.handlers.add(handler);
  }

  #emit(message) {
    for (const handler of this.handlers) {
      try {
        handler(message);
      } catch (error) {
        log(`事件处理异常：${error.message}`);
      }
    }
  }

  async start() {
    const serverArgs = ['app-server', '--listen', 'stdio://'];
    if (!USE_WS) serverArgs.push('-c', 'features.responses_websockets=false');
    const env = { ...process.env };
    if (PROXY) {
      env.HTTPS_PROXY = env.HTTPS_PROXY || PROXY;
      env.HTTP_PROXY = env.HTTP_PROXY || PROXY;
      env.ALL_PROXY = env.ALL_PROXY || PROXY;
      // 本机黑板/回环流量不要走代理
      env.NO_PROXY = env.NO_PROXY || '127.0.0.1,localhost,::1';
    }
    this.child = spawn('codex', serverArgs, {
      cwd: this.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      windowsHide: true,
    });

    this.child.stdout.on('data', (chunk) => this.#ingest(chunk.toString('utf8')));
    this.child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim();
      if (text && /error/i.test(text)) log(`app-server: ${text.slice(0, 200)}`);
    });
    this.child.on('exit', (code) => {
      this.ready = false;
      log(`app-server 退出（${code}）`);
      for (const [, entry] of this.pending) entry.reject(new Error('app-server 已退出'));
      this.pending.clear();
      this.#emit({ method: 'transport/exit', params: { code } });
    });

    await this.request('initialize', {
      clientInfo: { name: 'message-board', title: 'Message Board', version: '0.1.0' },
    });
    this.#write({ method: 'initialized' });
    this.ready = true;
    log(`已连接 Codex app-server（JSON-RPC over stdio${USE_WS ? '' : '，已关闭 responses websocket'}）`);
    log(PROXY ? `Codex 走代理：${PROXY}（NO_PROXY=${env.NO_PROXY}）` : 'Codex 未配置代理（直连）');
  }

  #write(message) {
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  #ingest(text) {
    this.buffer += text;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) entry.reject(Object.assign(new Error(message.error.message || 'app-server 错误'), { rpc: message.error }));
        else entry.resolve(message.result);
      } else if (message.method) {
        this.#emit(message);
      }
    }
  }

  request(method, params, { timeoutMs = 120000 } = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时（${timeoutMs / 1000}s）`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#write({ id, method, params });
    });
  }

  startThread() {
    return this.request('thread/start', {});
  }

  resumeThread(threadId) {
    return this.request('thread/resume', { threadId });
  }

  startTurn(threadId, text) {
    return this.request('turn/start', { threadId, input: [{ type: 'text', text }] });
  }

  steer(threadId, turnId, text) {
    // 协议要的是 expectedTurnId（实测：缺它会报 "missing field `expectedTurnId`"）
    return this.request('turn/steer', { threadId, expectedTurnId: turnId, input: [{ type: 'text', text }] });
  }

  interrupt(threadId, turnId) {
    return this.request('turn/interrupt', { threadId, turnId });
  }

  stop() {
    try {
      this.child?.kill();
    } catch {
      /* 忽略 */
    }
  }
}

/* ── 主流程 ─────────────────────────────────────────────── */

const channel = new CodexChannel({ cwd: WORKDIR });
const threads = readThreads();
let active = null; // { threadId, turnId, replyTo, seq, topic, text, ackId }
const deferred = []; // 正在跑别的议题时，先排队，避免覆盖 active 状态

function buildPrompt(envelope, recent, threadId) {
  const others = recent
    .filter((message) => message.seq !== envelope.seq)
    .slice(-8)
    .map((message) => `#${message.seq} [${message.agent}] ${String(message.text).replace(/\s+/g, ' ').slice(0, 260)}`)
    .join('\n');
  return `你是本地协作黑板「Message Board」上的成员：${IDENTITY.name}（id: ${AGENT}）。职位：${IDENTITY.title}。
你当前所处的 Codex 会话 thread id 是：${threadId}（如果回复里需要引用它，请用这个 id，不要凭印象编）。
黑板纪律：只追加；回复要含结论/依据/下一步；区分事实与推断；不写密钥；非必要不要 @ 别人；不要复述本提示。

${others ? `黑板最近的留言：\n${others}\n` : ''}
有人点名你（#${envelope.seq}，来自 @${envelope.from}${envelope.topic ? `，议题 ${envelope.topic}` : ''}）：

"""${String(envelope.text).slice(0, 1200)}"""

请直接给出要贴到黑板上的回复正文（中文，400 字以内）。`;
}

channel.onEvent(async (message) => {
  const method = message.method;
  const params = message.params || {};

  if (method === 'item/completed' && params.item?.type === 'agentMessage' && params.item?.phase === 'final_answer' && active) {
    active.finalText = params.item.text || '';
  }

  if (method === 'error' && active) {
    const text = params.error?.message || '';
    log(`会话报错：${text}`);
    active.lastError = text;
  }

  if (method === 'turn/completed' && active && params.turn?.id === active.turnId) {
    const finished = active;
    active = null;
    const text = (finished.finalText || '').trim();
    const body = text
      ? `${text}\n\n（Codex thread ${finished.threadId} —— 在 Codex 里打开同一次对话：codex resume ${finished.threadId}；本轮 ${Math.round((params.turn?.durationMs || 0) / 1000)}s）`
      : `【${IDENTITY.name} 通道】本轮结束但没有产出最终消息${finished.lastError ? `：${finished.lastError}` : ''}。本条为失败回执。`;
    try {
      const posted = await postBoard({
        agent: AGENT,
        text: body,
        kind: text ? 'reply' : 'notice',
        status: text ? '进行中' : '阻塞',
        topic: finished.topic || null,
        replyTo: finished.replyTo,
        client: { channel: 'codex-app-server', threadId: finished.threadId, turnId: finished.turnId },
      });
      log(`已回复 #${posted.message.seq}（回应 #${finished.seq}，thread ${finished.threadId}）`);
    } catch (error) {
      log(`回复写回失败：${error.message}`);
    }
    // 排队中的点名：这一轮结束后接着处理
    if (deferred.length) {
      const next = deferred.shift();
      log(`处理排队中的点名 #${next.seq}`);
      handleMention(next).catch((error) => log(`排队的点名处理失败：${error.message}`));
    }
  }

  if (method === 'transport/exit') {
    log('通道断开，5 秒后重连');
    setTimeout(() => main().catch((error) => log(`重连失败：${error.message}`)), 5000);
  }
});

async function handleMention(envelope) {
  const key = envelope.topic || '__default__';
  const state = await call('/api/state?limit=12');

  // 同一议题复用同一 thread：这就是"接着同一场对话继续"
  let threadId = threads[key];
  if (threadId) {
    try {
      await channel.resumeThread(threadId);
      log(`续接 thread ${threadId}（议题 ${key}）`);
    } catch (error) {
      log(`续接失败（${error.message}），新建 thread`);
      threadId = '';
    }
  }
  if (!threadId) {
    const started = await channel.startThread();
    threadId = started.thread?.id;
    threads[key] = threadId;
    writeThreads(threads);
    log(`新建 thread ${threadId}（议题 ${key}）`);
  }

  const text = buildPrompt(envelope, state.messages || [], threadId);

  // 正在跑这一轮 → 直接把新指令插进去（turn/steer），不另起一轮
  if (active && active.threadId === threadId) {
    try {
      await channel.steer(threadId, active.turnId, text);
      active.steered = active.steered || [];
      active.steered.push(envelope.seq);
      log(`已 steer 到进行中的回合（点名 #${envelope.seq}）`);
      await postBoard(
        {
          agent: AGENT,
          kind: 'notice',
          status: '进行中',
          topic: envelope.topic || null,
          replyTo: envelope.messageId,
          text: `已把 #${envelope.seq} 的补充指令插入正在进行的这一轮（thread ${threadId}，turn ${active.turnId}），无需另起对话。`,
          client: { channel: 'codex-app-server', steered: true, threadId, turnId: active.turnId },
        },
        { label: 'steer 通知' },
      );
    } catch (error) {
      log(`steer 失败：${error.message}`);
    }
    return;
  }

  // 正在跑别的议题 → 排队，等这一轮结束再处理（避免并发覆盖当前回合状态）
  if (active) {
    deferred.push(envelope);
    log(`当前有回合在跑（thread ${active.threadId}），点名 #${envelope.seq} 已排队`);
    await postBoard(
      {
        agent: AGENT,
        kind: 'notice',
        status: '进行中',
        topic: envelope.topic || null,
        replyTo: envelope.messageId,
        text: `排队中：正在处理 #${active.seq}（thread ${active.threadId}），本条将在那一轮结束后接着处理。`,
        client: { channel: 'codex-app-server', queued: true },
      },
      { label: '排队通知' },
    );
    return;
  }

  const turn = await channel.startTurn(threadId, text);
  active = {
    threadId,
    turnId: turn.turn?.id,
    replyTo: envelope.messageId,
    seq: envelope.seq,
    topic: envelope.topic || null,
  };
  log(`已在新回合处理 #${envelope.seq}（turn ${active.turnId}）`);

  await postBoard(
    {
      agent: AGENT,
      kind: 'notice',
      status: '进行中',
      topic: envelope.topic || null,
      replyTo: envelope.messageId,
      text: `已收到 #${envelope.seq} 的点名，正在 thread ${threadId} 的这一轮里处理（会流式产出，完成后把结论写回黑板）。本条为处理中通知，不是结论。`,
      client: { channel: 'codex-app-server', threadId, turnId: active.turnId },
    },
    { label: '处理中通知' },
  );
}

async function main() {
  await channel.start();

  const joined = await call('/api/join', {
    method: 'POST',
    body: JSON.stringify({ ...IDENTITY, channel: 'http' }),
  });
  log(`已登记为「${joined.agent.name}」（通道 codex-app-server）`);

  for (;;) {
    try {
      await call('/api/heartbeat', {
        method: 'POST',
        body: JSON.stringify({ agent: AGENT, state: 'online', note: active ? '正在处理点名' : 'Codex 通道在线' }),
      });
      const result = await call(`/api/inbox?agent=${encodeURIComponent(AGENT)}&wait=${WAIT_SECONDS}`);
      if (result.wake && result.wake.from !== AGENT) {
        await handleMention(result.wake);
      }
      if (!channel.ready) throw new Error('通道未就绪');
    } catch (error) {
      log(`循环异常：${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      if (!channel.ready) {
        try {
          await channel.start();
        } catch (restartError) {
          log(`重启通道失败：${restartError.message}`);
        }
      }
    }
  }
}

main().catch((error) => {
  console.error(`codex-channel 失败：${error.message}`);
  process.exitCode = 1;
});
