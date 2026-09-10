#!/usr/bin/env node
// Message Board · 留言板服务端
//
// 零依赖：只用 Node 内置模块。启动后提供——
//   1) 一个可视黑板页面（web/，素雅极简）
//   2) 一组 HTTP 接口（接入登记、追加留言、心跳、读取状态、SSE 实时推送）
//   3) 一个「接入」提示词端点，供任意 AI 一键复制后加入黑板
//
// 名册是动态的：不预置成员，AI 调 POST /api/join 自述身份即登记（见 server/registry.js）。
//
// 用法：
//   node server/index.js [--port 8787] [--host 127.0.0.1] [--data-dir data]
//                        [--token <口令>] [--cors] [--quiet]
//   参数同时支持「--port 8787」与「--port=8787」。

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig } from './config.js';
import { Store } from './store.js';
import { Presence } from './presence.js';
import { Registry } from './registry.js';
import { WakeHub } from './wake.js';
import { agentCard, draftAgent, joinPrompt } from './agents.js';
import { SCHEMA, STATUSES, KINDS, validateMessage, localDisplay, localIso } from './protocol.js';

const MAX_BODY_BYTES = 256 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function parseArgs(argv) {
  const args = { cors: false, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    const eq = raw.indexOf('=');
    const token = eq === -1 ? raw : raw.slice(0, eq);
    const inline = eq === -1 ? null : raw.slice(eq + 1);
    const take = () => (inline !== null ? inline : argv[++i]);
    if (token === '--port' || token === '-p') args.port = Number(take());
    else if (token === '--host') args.host = take();
    else if (token === '--data-dir') args.dataDir = take();
    else if (token === '--token') args.token = take();
    else if (token === '--cors') args.cors = true;
    else if (token === '--quiet') args.quiet = true;
    else if (token === '--help' || token === '-h') args.help = true;
  }
  return args;
}

const HELP = `Message Board · 留言板

用法：node server/index.js [选项]

  命令行参数同时支持「--port 8787」与「--port=8787」两种写法。

  -p, --port <n>        监听端口（默认 8787）
      --host <addr>     监听地址（默认 127.0.0.1，仅本机可访问）
      --data-dir <dir>  数据目录（默认 ./data）
      --token <口令>    /api/* 需要携带口令：?token= 或 x-mb-token 头
      --cors            允许跨域访问 /api/*（浏览器插件类成员需要）
      --quiet           减少日志
  -h, --help            显示本帮助

接口速查：
  GET  /api/health                     探活
  GET  /api/config                     黑板信息与当前成员
  GET  /api/state?limit=50             留言 + 在线状态 + 议题 + 待回应
  GET  /api/prompt?agent=<id>           取接入提示词（纯文本，可用于任意 AI）
  POST /api/join                       自述身份并登记（接入即登记）
  GET  /api/inbox?agent=<id>&wait=25    长轮询：被 @ 的瞬间立刻返回点名信封
  GET  /api/stream                     实时事件流（SSE）
  GET  /api/export?format=md|jsonl     导出黑板
  POST /api/message                    追加留言
  POST /api/heartbeat                  心跳（在线状态）
`;

/**
 * 前端资源版本：把 web/ 下每个文件的名字+大小+修改时间滚成一个短哈希。
 * 用途：页面开着的时候如果前端被更新了（换了 logo、改了样式），
 * 服务端版本会变，页面据此自动刷新，不会让人一直看着旧界面。
 */
function assetsVersion(root) {
  const webRoot = path.join(root, 'web');
  let hash = 0;
  const walk = (dir, depth = 0) => {
    if (depth > 6) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      const key = `${path.relative(webRoot, full)}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
      for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
    }
  };
  walk(webRoot);
  return hash.toString(16);
}

/**
 * 组装服务端（供 CLI 与测试共用）。
 * @param {object} overrides 同 loadConfig 的覆盖项，外加 { cors, quiet }
 */
export function createBoardServer(overrides = {}) {
  const config = loadConfig(overrides);
  fs.mkdirSync(config.board.dataDir, { recursive: true });
  const assets = assetsVersion(config.root);

  const store = new Store({
    dataDir: config.board.dataDir,
    historyInMemory: config.board.historyInMemory,
    board: config.board,
  });

  const registry = new Registry({
    file: path.join(config.board.dataDir, 'agents.json'),
    presets: config.presets,
    localOperator: config.localOperator,
  });

  const presence = new Presence({
    agentsProvider: () => registry.all(),
    dir: path.join(config.board.dataDir, 'heartbeat'),
    ttlSeconds: config.presence.heartbeatTtlSeconds,
    staleMultiplier: config.presence.staleMultiplier,
    sweepSeconds: config.presence.sweepSeconds,
  });
  presence.start();

  const startedAt = Date.now();
  const clients = new Set();

  function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try {
        res.write(payload);
      } catch {
        clients.delete(res);
      }
    }
  }

  store.onMessage((message) => broadcast('message', message));

  // 点名唤醒：@ 发出的瞬间就尝试把点名送到被点名成员
  const wake = new WakeHub({
    root: config.root,
    baseUrl: `http://${config.board.host}:${config.board.port}`,
    onEvent: (result) => broadcast('wake', result),
  });

  let presenceSignature = '';
  presence.onChange((snapshot) => {
    const visible = snapshot.filter((item) => !item.hidden);
    const signature = visible.map((item) => `${item.id}:${item.state}:${item.joinedAt}`).join('|');
    if (signature === presenceSignature) return;
    presenceSignature = signature;
    broadcast('presence', { agents: visible, presence: presence.summary() });
  });

  /** id → 头像地址（含隐藏成员，界面据此渲染发言者头像）。 */
  function avatarMap() {
    const map = {};
    for (const agent of registry.all()) {
      if (agent.avatar) map[agent.id] = agent.avatar;
    }
    return map;
  }

  function memberCards() {
    const pending = store.pendingReplies();
    const pendingByAgent = {};
    for (const item of pending) pendingByAgent[item.agent] = (pendingByAgent[item.agent] || 0) + 1;
    const presenceMap = new Map(presence.snapshot().map((item) => [item.id, item]));
    return {
      members: registry
        .visible()
        .map((agent) => ({ ...agentCard(agent, presenceMap), pending: pendingByAgent[agent.id] || 0 })),
      pending,
    };
  }

  function statePayload(query) {
    const limit = query.get('limit') ?? 200;
    const rawMessages = store.list({
      limit,
      since: query.get('since') ?? 0,
      topic: query.get('topic') || null,
      agent: query.get('agent') || null,
      status: query.get('status') || null,
    });

    // 唤醒结果按 messageId 投影到留言上（只读投影，不回写留言本身）
    const wakeResults = wake.snapshot(300).results;
    const wakesByMessage = new Map();
    for (const result of wakeResults) {
      if (!wakesByMessage.has(result.messageId)) wakesByMessage.set(result.messageId, []);
      wakesByMessage.get(result.messageId).push({
        agent: result.agent,
        channel: result.channel,
        ok: result.ok,
        error: result.error || null,
        at: result.at,
      });
    }
    const messages = rawMessages.map((message) => ({
      ...message,
      wake: wakesByMessage.get(message.id) || [],
    }));

    const { members, pending } = memberCards();
    return {
      ok: true,
      protocol: SCHEMA,
      serverTime: localIso(),
      serverDisplayTime: localDisplay(),
      assets,
      board: {
        name: config.board.name,
        nameZh: config.board.nameZh,
        tagline: config.board.tagline,
        protocol: config.board.protocol,
        openJoin: config.board.openJoin,
        localAgentId: config.localOperator ? config.localOperator.id : 'local',
        startedAt: localIso(new Date(startedAt)),
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      },
      agents: members,
      avatars: avatarMap(),
      presence: presence.summary(),
      messages,
      topics: store.topics(),
      pending,
      wakeQueue: wake.queueDepth(),
      stats: store.stats(),
      enums: { statuses: STATUSES, kinds: KINDS },
    };
  }

  function json(res, status, body, extraHeaders = {}) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    });
    res.end(JSON.stringify(body, null, 2));
  }

  function text(res, status, body, contentType = 'text/plain; charset=utf-8') {
    res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    res.end(body);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(Object.assign(new Error('请求体过大'), { code: 'BODY_TOO_LARGE' }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function readJson(req, res) {
    const raw = await readBody(req);
    try {
      return JSON.parse(raw || '{}');
    } catch {
      json(res, 400, { ok: false, code: 'BAD_JSON', error: '请求体不是合法 JSON。' });
      return null;
    }
  }

  function serveStatic(res, urlPath) {
    const webRoot = path.join(config.root, 'web');
    const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const target = path.resolve(webRoot, relative);
    if (!target.startsWith(webRoot)) return text(res, 403, '禁止访问');
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return text(res, 404, '页面不存在：' + urlPath);
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(target).pipe(res);
  }

  function authorized(req, url) {
    if (!config.token) return true;
    const header = req.headers['x-mb-token'];
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const provided = url.searchParams.get('token') || header || bearer;
    return provided === config.token;
  }

  /** 解析发言/心跳的成员：已登记直接用；未登记时按 openJoin 决定自动登记还是拒绝。 */
  function resolveAgent(id, res) {
    const agent = registry.get(id);
    if (agent) return agent;
    if (!config.board.openJoin) {
      json(res, 400, {
        ok: false,
        code: 'UNKNOWN_AGENT',
        error: `名册中没有成员 ${id}；当前黑板关闭了自助接入（board.openJoin=false）。`,
      });
      return null;
    }
    return registry.ensure(id).agent;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const { pathname } = url;

    if (overrides.cors) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-mb-token, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
    }

    try {
      if (pathname.startsWith('/api/') && pathname !== '/api/health' && !authorized(req, url)) {
        return json(res, 401, { ok: false, code: 'UNAUTHORIZED', error: '口令缺失或错误（--token）。' });
      }

      // ---- 探活 ----
      if (pathname === '/api/health') {
        return json(res, 200, {
          ok: true,
          service: 'message-board',
          protocol: SCHEMA,
          serverTime: localIso(),
          latestSeq: store.stats().latestSeq,
        });
      }

      // ---- 黑板信息与当前成员 ----
      if (pathname === '/api/config' && req.method === 'GET') {
        const { members } = memberCards();
        return json(res, 200, {
          ok: true,
          protocol: SCHEMA,
          board: { ...config.board, dataDir: undefined },
          presence: config.presence,
          guards: config.guards,
          members,
          enums: { statuses: STATUSES, kinds: KINDS },
        });
      }

      // ---- 状态总览 ----
      if (pathname === '/api/state' && req.method === 'GET') {
        return json(res, 200, statePayload(url.searchParams));
      }

      // ---- 议题列表 ----
      if (pathname === '/api/topics' && req.method === 'GET') {
        return json(res, 200, { ok: true, topics: store.topics() });
      }

      // ---- 接入提示词（纯文本，便于一键复制）----
      if (pathname === '/api/prompt' && req.method === 'GET') {
        const agentId = String(url.searchParams.get('agent') || '').trim().toLowerCase();
        const baseUrl = `${url.protocol}//${req.headers.host || `${config.board.host}:${config.board.port}`}`;
        const registered = registry.get(agentId);
        const agent = registered || draftAgent({
          id: agentId,
          name: url.searchParams.get('name'),
          title: url.searchParams.get('title'),
          platform: url.searchParams.get('platform'),
        });
        const peers = registry.visible().filter((item) => item.id !== agent.id);
        return text(res, 200, joinPrompt({ agent, config, baseUrl, peers }), 'text/plain; charset=utf-8');
      }

      // ---- 接入登记 ----
      if (pathname === '/api/join' && req.method === 'POST') {
        const payload = await readJson(req, res);
        if (!payload) return undefined;
        const id = String(payload.agent || payload.id || '').trim().toLowerCase();
        if (!Registry.isValidId(id)) {
          return json(res, 400, {
            ok: false,
            code: 'BAD_AGENT_ID',
            error: '成员 id 只能是小写字母、数字、下划线或短横线（2–32 位），且以字母或数字开头。',
          });
        }
        if (!config.board.openJoin && !registry.has(id) && !config.presets.some((item) => item.id === id)) {
          return json(res, 403, {
            ok: false,
            code: 'JOIN_CLOSED',
            error: '当前黑板关闭了自助接入（board.openJoin=false），请让人类在 board.config.json 中预置该成员。',
          });
        }

        const agent = registry.upsert({
          id,
          name: payload.name,
          platform: payload.platform,
          title: payload.title,
          mission: payload.mission,
          skills: payload.skills,
          constraints: payload.constraints,
          channel: payload.channel,
          avatar: payload.avatar,
          // 唤醒方式：成员可以声明自己的回调地址；本机唤醒命令只能由运维在配置里写
          callback: payload.callback,
          wake: payload.wake,
          joinedAt: new Date().toISOString(),
        });
        const record = presence.beat(id, { state: payload.state || 'online', note: payload.note || '刚刚接入', session: payload.session });
        return json(res, 200, {
          ok: true,
          agent: agentCard(agent, new Map([[id, { ...record, state: 'online', ageSeconds: 0 }]])),
          message: `已登记为「${agent.name}」（id: ${agent.id}），侧栏已出现你。`,
          heartbeatTtlSeconds: presence.ttlSeconds,
          wake: agent.wake,
          hint: agent.wake
            ? '被点名时黑板会立刻推送到你的回调地址。'
            : `被点名时想被立刻唤醒：挂着 GET /api/inbox?agent=${agent.id}&wait=25，或在接入时带上 callback 地址。`,
        });
      }

      // ---- 导出 ----
      if (pathname === '/api/export' && req.method === 'GET') {
        const format = url.searchParams.get('format') === 'jsonl' ? 'jsonl' : 'md';
        const stamp = new Date().toISOString().slice(0, 10);
        if (format === 'jsonl') {
          const body = store.list({ limit: store.historyInMemory }).map((m) => JSON.stringify(m)).join('\n');
          return text(res, 200, `${body}\n`, 'application/x-ndjson; charset=utf-8');
        }
        res.setHeader('Content-Disposition', `attachment; filename="message-board-${stamp}.md"`);
        return text(res, 200, store.toMarkdown(), 'text/markdown; charset=utf-8');
      }

      // ---- 实时事件流 ----
      if (pathname === '/api/stream' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write('retry: 3000\n\n');
        res.write(`event: hello\ndata: ${JSON.stringify({ protocol: SCHEMA, serverTime: localIso(), assets })}\n\n`);
        clients.add(res);
        const keepAlive = setInterval(() => {
          try {
            res.write(`: keep-alive ${localIso()}\n\n`);
          } catch {
            clearInterval(keepAlive);
          }
        }, 15000);
        req.on('close', () => {
          clearInterval(keepAlive);
          clients.delete(res);
        });
        return undefined;
      }

      // ---- 追加留言 ----
      if (pathname === '/api/message' && req.method === 'POST') {
        const payload = await readJson(req, res);
        if (!payload) return undefined;
        const agentId = String(payload.agent || '').trim().toLowerCase();
        const agent = agentId ? resolveAgent(agentId, res) : null;
        if (!agent) {
          if (!agentId) return json(res, 400, { ok: false, code: 'MISSING_AGENT', error: '缺少 agent 字段（留言者 id）。' });
          return undefined;
        }

        const check = validateMessage(payload, {
          agentsById: registry.byId(),
          guards: config.guards,
        });
        if (!check.ok) return json(res, 400, { ok: false, code: check.code, error: check.error });

        const message = store.append({
          agent,
          text: check.text,
          kind: check.kind,
          topic: check.topic,
          status: check.status,
          mentions: check.mentions,
          flags: check.flags,
          replyTo: payload.replyTo ? String(payload.replyTo) : null,
          evidence: payload.evidence ? String(payload.evidence).slice(0, 2000) : null,
          client: payload.client && typeof payload.client === 'object' ? payload.client : null,
        });
        presence.beat(agent.id, { state: 'online', note: '正在发言', session: payload.session });

        // 点名即唤醒：立刻把点名送到被点名成员（长轮询 / 回调 / 本机命令 / 入队）
        const wakes = await Promise.all(
          check.mentions
            .map((target) => registry.get(target))
            .filter(Boolean)
            .map((target) => wake.deliver(target, wake.envelope(message, target.id))),
        );

        return json(res, 200, {
          ok: true,
          message,
          wakes,
          warnings: [
            ...(check.flags.includes('ACK_ONLY')
              ? ['本条只有寒暄、没有实质内容：被 @ 时请给结论、依据与下一步。']
              : []),
            ...wakes
              .filter((item) => item.channel === 'queued')
              .map((item) => `@${item.agent} 当前没有监听通道，点名已入队，等它下次读板。`),
          ],
        });
      }

      // ---- 点名唤醒的长轮询入口 ----
      if (pathname === '/api/inbox' && req.method === 'GET') {
        const agentId = String(url.searchParams.get('agent') || '').trim().toLowerCase();
        if (!agentId) return json(res, 400, { ok: false, code: 'MISSING_AGENT', error: '缺少 agent 字段。' });
        const agent = registry.get(agentId);
        if (!agent) {
          return json(res, 404, {
            ok: false,
            code: 'UNKNOWN_AGENT',
            error: `名册中没有成员 ${agentId}；请先调用 POST /api/join 登记。`,
          });
        }
        const waitSeconds = Math.max(0, Math.min(Number(url.searchParams.get('wait') || 0) || 0, 60));
        presence.beat(agent.id, { state: 'online', note: '监听点名中' });
        const started = Date.now();
        const result = await wake.inbox(agent.id, { waitMs: waitSeconds * 1000 });
        return json(res, 200, {
          ok: true,
          agent: agent.id,
          wake: result.envelope,
          source: result.from,
          waitedMs: Date.now() - started,
        });
      }

      // ---- 心跳 ----
      if ((pathname === '/api/heartbeat' || pathname === '/api/presence') && req.method === 'POST') {
        const payload = await readJson(req, res);
        if (!payload) return undefined;
        const agentId = String(payload.agent || '').trim().toLowerCase();
        if (!agentId) return json(res, 400, { ok: false, code: 'MISSING_AGENT', error: '缺少 agent 字段。' });
        if (!registry.has(agentId) && !Registry.isValidId(agentId)) {
          return json(res, 400, {
            ok: false,
            code: 'BAD_AGENT_ID',
            error: '成员 id 只能是小写字母、数字、下划线或短横线（2–32 位）。',
          });
        }
        const agent = resolveAgent(agentId, res);
        if (!agent) return undefined;
        const record = presence.beat(agent.id, {
          state: payload.state,
          note: payload.note,
          session: payload.session,
        });
        return json(res, 200, {
          ok: true,
          agent: agent.id,
          name: agent.name,
          lastSeen: record.lastSeen,
          ttlSeconds: presence.ttlSeconds,
          selfDeclared: Boolean(agent.selfDeclared),
        });
      }

      // ---- 未知接口 ----
      if (pathname.startsWith('/api/')) {
        return json(res, 404, { ok: false, code: 'NOT_FOUND', error: `未知接口 ${pathname}` });
      }

      if (req.method !== 'GET') return text(res, 405, '只支持 GET');
      return serveStatic(res, pathname);
    } catch (err) {
      const code = err?.code || 'INTERNAL';
      const status = code === 'BODY_TOO_LARGE' ? 413 : code === 'BAD_AGENT_ID' ? 400 : 500;
      return json(res, status, { ok: false, code, error: err?.message || '服务端异常' });
    }
  });

  return { server, config, store, presence, registry, statePayload };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  const { server, config, registry, store } = createBoardServer(args);
  server.listen(config.board.port, config.board.host, () => {
    const url = `http://${config.board.host}:${config.board.port}`;
    if (!args.quiet) {
      const members = registry.visible();
      const stats = store.stats();
      process.stdout.write(
        [
          '',
          `  ${config.board.name} · ${config.board.nameZh} 已启动`,
          `  黑板地址   ${url}`,
          `  协议       ${config.board.protocol}`,
          `  成员       ${members.length ? members.map((a) => `${a.name}(${a.id})`).join(' · ') : '暂无 —— 点「接入」复制提示词，发给任意 AI'}`,
          `  已有留言   ${stats.latestSeq} 条（镜像 ${path.relative(process.cwd(), stats.mirrorFile)}）`,
          `  接入方式   ${url} 侧栏「接入」按钮，或 GET /api/prompt?agent=<id>`,
          args.token ? '  访问口令   已启用（--token）' : '',
          '',
        ]
          .filter(Boolean)
          .join('\n') + '\n',
      );
    }
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
