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
// 沙箱模式：默认 read-only —— 成员能读文件、能跑只读命令、能检索，但不许改动工作目录。
// 需要它产出文件（例如写审计报告）时用 --sandbox workspace-write 打开。
const SANDBOX_MODE = flag('sandbox', 'read-only');

const IDENTITY = {
  id: AGENT,
  name: flag('name', 'Codex'),
  title: flag('title', '项目主 Agent'),
  platform: flag('platform', 'Codex app-server'),
  mission: flag('mission', '目标拆解、代码实现、事实核验与最终技术决策'),
  skills: flag('skills', '长上下文编码与重构、测试与验证'),
  constraints: flag('constraints', '不臆断未验证的事实；不把构建通过写成端到端通过'),
  // 引擎：这一路不是 codex exec，而是常驻的 app-server 通道（能中途打断、能续同一线程）。
  // 如实声明，面板上就不会把它和 "codex-cli" 混为一谈。
  engine: flag('engine', 'codex-app-server'),
};

const RUNTIME_DIR = flag('runtime', path.join(process.cwd(), 'data', 'runner', AGENT));
const THREADS_FILE = () => path.join(RUNTIME_DIR, 'threads.json');
// 在跑回合的落盘记录：通道若被重启/杀掉，下一次启动能立刻上报"这一轮丢了"，
// 让黑板立即重投，而不是干等 180 秒租约。
const ACTIVE_FILE = () => path.join(RUNTIME_DIR, 'active-turn.json');
const PROXY = detectProxy();

/**
 * 找出 codex.exe 本体，直接 spawn 它——绕开 cmd.exe。
 * npm 装的 codex 是个 .cmd 垫片，以往只能经 cmd.exe 调用，于是踩了两个坑：
 *   ① shell 包裹导致引号拼接出错；② 自启动环境里 ComSpec 为空时 spawn cmd.exe 直接 ENOENT。
 * 直接调 exe 两个问题一起消失，还少一层进程。
 */
function resolveCodexBinary() {
  const explicit = flag('codex-bin') || process.env.MB_CODEX_BIN || process.env.CODEX_CLI_PATH;
  const candidates = [];
  if (explicit) candidates.push(explicit);
  candidates.push(
    path.join(
      process.env.APPDATA || '',
      'npm',
      'node_modules',
      '@openai',
      'codex',
      'node_modules',
      '@openai',
      'codex-win32-x64',
      'vendor',
      'x86_64-pc-windows-msvc',
      'bin',
      'codex.exe',
    ),
  );
  try {
    const base = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
    for (const dir of fs.readdirSync(base)) candidates.push(path.join(base, dir, 'codex.exe'));
  } catch {
    /* 桌面 App 未安装 */
  }
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      /* 继续找下一个 */
    }
  }
  return '';
}

const CODEX_BIN = resolveCodexBinary();

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

/** 记下"当前在跑的回合"，供重启后上报丢失。 */
function writeActive(record) {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(ACTIVE_FILE(), JSON.stringify(record, null, 2), 'utf8');
  } catch (error) {
    log(`active-turn 落盘失败：${error.message}`);
  }
}

function clearActive() {
  try {
    fs.rmSync(ACTIVE_FILE(), { force: true });
  } catch {
    /* 删不掉不影响主流程 */
  }
}

function readActive() {
  try {
    return JSON.parse(stripBom(fs.readFileSync(ACTIVE_FILE(), 'utf8')));
  } catch {
    return null;
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
    // 注意：不要在这里嵌双引号。这个命令串最终经 shell:true 交给 cmd.exe，
    // Node 会把整串再包一层引号，内层引号会让 cmd 解析崩溃（曾导致 spawn cmd.exe ENOENT）。
    // Codex 对不符合 TOML 的值按字面量处理，所以 sandbox_mode=read-only 这样写是合法的。
    serverArgs.push('-c', `sandbox_mode=${SANDBOX_MODE}`, '-c', 'approval_policy=never');
    const env = { ...process.env };
    // Windows 上环境块缺关键变量（尤其是 SystemRoot）会让 CreateProcess 直接报 ENOENT，
    // 看起来像"文件不存在"，其实只是环境不完整。这里补齐必需项。
    const essentials = {
      SystemRoot: process.env.SystemRoot || 'C:\\Windows',
      windir: process.env.windir || process.env.SystemRoot || 'C:\\Windows',
      ComSpec: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
      PATHEXT: process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD',
    };
    for (const [key, value] of Object.entries(essentials)) {
      if (!env[key]) env[key] = value;
    }
    if (!env.PATH) env.PATH = `${essentials.SystemRoot}\\System32;${essentials.SystemRoot}`;
    if (PROXY) {
      env.HTTPS_PROXY = env.HTTPS_PROXY || PROXY;
      env.HTTP_PROXY = env.HTTP_PROXY || PROXY;
      env.ALL_PROXY = env.ALL_PROXY || PROXY;
      // 本机黑板/回环流量不要走代理
      env.NO_PROXY = env.NO_PROXY || '127.0.0.1,localhost,::1';
    }
    // 先带自定义 env 试一次；若 spawn 失败（Windows 上环境不完整会报 ENOENT），
    // 再用原样环境重试一次——宁可少注入代理，也要先把通道接上。
    const attempts = [
      { label: '注入 env', env },
      { label: '原样 env', env: process.env },
    ];
    let lastError = null;
    for (const attempt of attempts) {
      try {
        await this.#spawnAndHandshake(serverArgs, attempt.env);
        log(`已连接 Codex app-server（JSON-RPC over stdio${USE_WS ? '' : '，已关闭 responses websocket'}；${attempt.label}）`);
        log(PROXY && attempt.env === env ? `Codex 走代理：${PROXY}（NO_PROXY=${env.NO_PROXY}）` : 'Codex 未走代理注入');
        return;
      } catch (error) {
        lastError = error;
        log(`启动失败（${attempt.label}）：${error.message}`);
        try {
          this.child?.kill();
        } catch {
          /* 忽略 */
        }
      }
    }
    throw lastError || new Error('无法启动 Codex app-server');
  }

  /** 起一个 app-server 并完成握手；spawn 失败/握手超时都会 reject。 */
  async #spawnAndHandshake(serverArgs, childEnv) {
    const command = ['codex', ...serverArgs].join(' ');
    const comspec = childEnv.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
    const spawnOptions = {
      cwd: this.cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    };

    // 优先直接 spawn codex.exe（不经过 shell）；找不到 exe 才回退到 cmd.exe 调 .cmd 垫片。
    if (CODEX_BIN) {
      this.child = spawn(CODEX_BIN, serverArgs, spawnOptions);
      log(`启动 app-server：${CODEX_BIN}`);
    } else if (process.platform === 'win32') {
      this.child = spawn(comspec, ['/d', '/s', '/c', command], spawnOptions);
      log(`启动 app-server（经 cmd.exe 回退）：${command}`);
    } else {
      this.child = spawn('/bin/sh', ['-c', command], spawnOptions);
      log(`启动 app-server：${command}`);
    }

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

    // 关键：spawn 失败必须被接住。未处理的 'error' 事件会直接崩掉整个通道进程
    // （这正是自启动场景下通道静默消失的原因）。
    const spawnFailed = new Promise((_, reject) => {
      this.child.once('error', (error) => reject(new Error(`spawn 失败：${error.code || ''} ${error.message}`)));
    });

    await Promise.race([
      (async () => {
        await this.request(
          'initialize',
          { clientInfo: { name: 'message-board', title: 'Message Board', version: '0.1.0' } },
          { timeoutMs: 25000 },
        );
        this.#write({ method: 'initialized' });
        this.ready = true;
      })(),
      spawnFailed,
    ]);
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
你的工作目录：${WORKDIR}（沙箱模式：${SANDBOX_MODE}——${SANDBOX_MODE === 'read-only' ? '可以读文件、跑只读命令、检索，但**不能修改文件**；这不影响你交付结论，别拿它当借口' : '可以读写文件，请把产物落盘并给出路径'}）。
你当前所处的 Codex 会话 thread id 是：${threadId}（回复里引用它时用这个 id，不要凭印象编）。

## 这是一件要交付的工作，不是一场讨论

**先动手，再回话。** 收到任务后你应该真的去执行：读文件、跑命令、检索、写产物。只有做完之后，才把结果贴到黑板上。

**禁止**把"关于任务的状态"当成交付，例如：
- 「尚未完成」「本轮被打断」「我将从…开始逐个阅读」
- 「需要更多信息」「请补充…」——除非你已经**实际尝试过**并给出尝试证据
- 复述黑板纪律、复述本段提示词、讨论黑板协议本身

**如果确实做不到**，你必须给出三样东西，缺一不可：
1. 你实际执行了什么（命令/路径/检索词，可原样复现）；
2. 你看到的原始结果或报错（贴关键输出，不要转述）；
3. 你判断的阻塞点，以及解除它需要什么。

## 交付格式（贴到黑板上的正文）

1. **结论 / 产物**：可以直接使用的结果。若写了文件，给出**绝对路径**；若是清单，直接列出来。
2. **证据**：文件路径+行号、命令+关键输出片段、链接——可复核，不要只给判断。
3. **剩余风险或未覆盖面**：明确说清哪部分没做、为什么。
4. 篇幅不限，但不要注水。${SANDBOX_MODE === 'read-only' ? '只读环境下请把完整内容直接贴在黑板上（不要把"不能写文件"当阻塞点）。' : '长内容优先落到文件里，黑板给摘要 + 绝对路径。'}

${others ? `黑板最近的留言（上下文，含你自己此前说过的话）：\n${others}\n` : ''}
有人点名你（#${envelope.seq}，来自 @${envelope.from}${envelope.topic ? `，议题 ${envelope.topic}` : ''}）：

"""${String(envelope.text).slice(0, 1500)}"""

现在开始执行。完成后，把上面「交付格式」的正文作为你的回复返回（它会原样贴到黑板）。`;
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
    clearActive();
    const text = (finished.finalText || '').trim();
    if (finished.interrupted) {
      try {
        await postBoard({
          agent: AGENT,
          kind: 'notice',
          status: '阻塞',
          topic: finished.topic || null,
          replyTo: finished.replyTo,
          idempotencyKey: `codex-app-server:${finished.replyTo}:interrupted`,
          text: `本轮已被人类打断（thread ${finished.threadId}，turn ${finished.turnId}）${text ? `。打断前已产出的内容：${text.slice(0, 300)}` : '。'}`,
          client: { channel: 'codex-app-server', threadId: finished.threadId, interrupted: true },
        });
        log(`已回报打断：#${finished.seq}`);
      } catch (error) {
        log(`打断回报失败：${error.message}`);
      }
    } else {
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
          idempotencyKey: `codex-app-server:${finished.replyTo}:${text ? 'reply' : 'failed'}`,
          client: { channel: 'codex-app-server', threadId: finished.threadId, turnId: finished.turnId },
        });
        log(`已回复 #${posted.message.seq}（回应 #${finished.seq}，thread ${finished.threadId}）`);
      } catch (error) {
        log(`回复写回失败：${error.message}`);
      }
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
  writeActive({ ...active, startedAt: new Date().toISOString() });
  log(`已在新回合处理 #${envelope.seq}（turn ${active.turnId}）`);

  await postBoard(
    {
      agent: AGENT,
      kind: 'notice',
      status: '进行中',
      topic: envelope.topic || null,
      replyTo: envelope.messageId,
      idempotencyKey: `codex-app-server:${envelope.messageId}:ack`,
      text: `已收到 #${envelope.seq} 的点名，正在 thread ${threadId} 的这一轮里处理（会流式产出，完成后把结论写回黑板）。本条为处理中通知，不是结论。`,
      client: { channel: 'codex-app-server', threadId, turnId: active.turnId },
    },
    { label: '处理中通知' },
  );
}

/** 控制指令：目前支持「打断」正在进行的回合。 */
async function handleControl(control) {
  log(`收到控制指令：${control.action}${control.reason ? `（${control.reason}）` : ''}`);
  if (control.action !== 'interrupt') return;
  if (!active) {
    await postBoard(
      {
        agent: AGENT,
        kind: 'notice',
        status: '进行中',
        topic: null,
        idempotencyKey: `codex-app-server:control:${control.at}`,
        text: '收到打断指令，但当前没有正在进行的回合，无需打断。',
        client: { channel: 'codex-app-server', control: control.action },
      },
      { label: '打断回执' },
    );
    return;
  }
  try {
    await channel.interrupt(active.threadId, active.turnId);
    active.interrupted = true;
    log(`已打断 thread ${active.threadId} 的 turn ${active.turnId}`);
  } catch (error) {
    log(`打断失败：${error.message}`);
    await postBoard(
      {
        agent: AGENT,
        kind: 'notice',
        status: '阻塞',
        topic: null,
        idempotencyKey: `codex-app-server:control:${control.at}:failed`,
        text: `打断失败：${error.message}。本条为失败回执。`,
        client: { channel: 'codex-app-server', control: control.action, ok: false },
      },
      { label: '打断失败回执' },
    );
  }
}

async function main() {
  await channel.start();

  const joined = await call('/api/join', {
    method: 'POST',
    body: JSON.stringify({ ...IDENTITY, channel: 'http' }),
  });
  log(`已登记为「${joined.agent.name}」（通道 codex-app-server）`);

  // 报到留言 = 接入自检表：把这一侧的真实证据贴到黑板，而不是只说"我接入了"
  await postBoard(
    {
      agent: AGENT,
      kind: 'notice',
      status: '进行中',
      topic: null,
      // 稳定幂等键：通道重启不该在黑板上刷出第二张自检表
      idempotencyKey: 'codex-app-server:selfcheck',
      text: [
        `接入自检表（${IDENTITY.name}）`,
        '',
        '| 检查项 | 结果 |',
        '| --- | --- |',
        `| 黑板探活 /api/health | 通过（${BOARD}） |`,
        `| 身份登记 /api/join | 通过（id=${AGENT}，称呼=${IDENTITY.name}） |`,
        `| 唤醒通道 | 长轮询 /api/inbox（wait=${WAIT_SECONDS}s）+ Codex app-server 常驻 |`,
        `| 能否收到点名 | 收到即在同一 thread 内处理，并按 replyTo 回实质回复 |`,
        `| 网络 / 代理 | ${PROXY ? `已注入系统代理 ${PROXY}` : '未配置代理（直连）'}；NO_PROXY=127.0.0.1,localhost,::1 |`,
        `| 承诺的回应方式 | 被 @ 立即回「处理中」通知，完成后给出结论 / 依据 / 下一步 |`,
      ].join('\n'),
      client: { channel: 'codex-app-server', selfCheck: true, proxy: PROXY || null },
    },
    { label: '自检表' },
  );
  log('已贴出接入自检表');

  // 上一次运行时被重启/杀掉，手里那一轮就丢了：立刻上报，让黑板马上重投。
  // 不这样做的话，投递会停在 working 直到 180 秒租约到期，用户看到的就是"没反应"。
  const lost = readActive();
  if (lost && lost.replyTo) {
    log(`发现上次未完成的回合（#${lost.seq}，thread ${lost.threadId}），上报丢失并请求重投`);
    try {
      await postBoard(
        {
          agent: AGENT,
          kind: 'notice',
          status: '进行中',
          topic: lost.topic || null,
          replyTo: lost.replyTo,
          idempotencyKey: `codex-app-server:${lost.replyTo}:lost`,
          text: `通道上一次运行时被中断：#${lost.seq} 的那一轮（thread ${lost.threadId}）没有跑完，已请求黑板立即重投，不需要等租约到期。本条为基础设施丢失回执，不是结论。`,
          client: { channel: 'codex-app-server', aborted: true, threadId: lost.threadId, turnId: lost.turnId },
        },
        { label: '丢失上报' },
      );
    } catch (error) {
      log(`丢失上报失败：${error.message}`);
    }
  }
  clearActive();

  for (;;) {
    try {
      // 忙碌时自报 busy + 具体在处理哪一条：黑板只续租"被自报正在处理"的那条投递，
      // 这样一旦通道把活弄丢，那条投递会按租约正常超时回收，不会被无限续租掩盖。
      await call('/api/heartbeat', {
        method: 'POST',
        body: JSON.stringify({
          agent: AGENT,
          state: active ? 'busy' : 'online',
          note: active ? `正在处理 #${active.seq}` : 'Codex 通道在线',
        }),
      });
      const result = await call(`/api/inbox?agent=${encodeURIComponent(AGENT)}&wait=${WAIT_SECONDS}`);
      if (result.wake?.type === 'control') {
        await handleControl(result.wake);
      } else if (result.wake && result.wake.from !== AGENT) {
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
