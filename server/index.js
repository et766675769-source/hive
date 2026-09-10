#!/usr/bin/env node
// Message Board · 留言板服务端
//
// 零依赖：只用 Node 内置模块。启动后提供——
//   1) 一个可视黑板页面（web/，素雅极简）
//   2) 一组 HTTP 接口（追加留言、心跳、读取状态、SSE 实时推送）
//   3) 一个「快速接入」提示词端点，供任意 AI 一键复制后加入黑板
//
// 用法：
//   node server/index.js [--port 8787] [--host 127.0.0.1] [--data-dir data]
//                        [--token <口令>] [--cors] [--quiet]

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig } from './config.js';
import { Store } from './store.js';
import { Presence } from './presence.js';
import { agentCard, genericPrompt, joinPrompt } from './agents.js';
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
    // 同时支持 `--port 8787` 与 `--port=8787`
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
  GET  /api/config                     黑板信息与成员名册
  GET  /api/state?limit=50             留言 + 在线状态 + 议题 + 待回应
  GET  /api/prompt?agent=<id>          取某成员的接入提示词（纯文本）
  GET  /api/stream                     实时事件流（SSE）
  GET  /api/export?format=md|jsonl     导出黑板
  POST /api/message                    追加留言
  POST /api/heartbeat                  心跳（在线状态）
`;

/**
 * 组装服务端（供 CLI 与测试共用）。
 * @param {object} overrides 同 loadConfig 的覆盖项，外加 { cors, quiet }
 */
export function createBoardServer(overrides = {}) {
  const config = loadConfig(overrides);
  const store = new Store({
    dataDir: config.board.dataDir,
    historyInMemory: config.board.historyInMemory,
    board: config.board,
  });
  const presence = new Presence({
    agents: config.agents,
    dir: path.join(config.board.dataDir, 'heartbeat'),
    ttlSeconds: config.presence.heartbeatTtlSeconds,
    staleMultiplier: config.presence.staleMultiplier,
    sweepSeconds: config.presence.sweepSeconds,
  });

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
  presence.onChange((snapshot) => broadcast('presence', { agents: snapshot, presence: presence.summary() }));

  function presenceMap() {
    return new Map(presence.snapshot().map((item) => [item.id, item]));
  }

  function statePayload(query) {
    const limit = query.get('limit') ?? 200;
    const messages = store.list({
      limit,
      since: query.get('since') ?? 0,
      topic: query.get('topic') || null,
      agent: query.get('agent') || null,
      status: query.get('status') || null,
    });
    const pending = store.pendingReplies();
    const pendingByAgent = {};
    for (const item of pending) pendingByAgent[item.agent] = (pendingByAgent[item.agent] || 0) + 1;
    const cards = config.agents.map((agent) => ({
      ...agentCard(agent, presenceMap()),
      pending: pendingByAgent[agent.id] || 0,
    }));
    return {
      ok: true,
      protocol: SCHEMA,
      serverTime: localIso(),
      serverDisplayTime: localDisplay(),
      board: {
        name: config.board.name,
        nameZh: config.board.nameZh,
        tagline: config.board.tagline,
        protocol: config.board.protocol,
        startedAt: localIso(new Date(startedAt)),
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      },
      agents: cards,
      presence: presence.summary(),
      messages,
      topics: store.topics(),
      pending,
      stats: store.stats(),
      enums: { statuses: STATUSES, kinds: KINDS },
    };
  }

  function json(res, status, body, extraHeaders = {}) {
    const text = JSON.stringify(body, null, 2);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    });
    res.end(text);
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

      // ---- 黑板信息与名册 ----
      if (pathname === '/api/config' && req.method === 'GET') {
        return json(res, 200, {
          ok: true,
          protocol: SCHEMA,
          board: { ...config.board, dataDir: undefined },
          presence: config.presence,
          guards: config.guards,
          agents: config.agents,
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
        const agentId = String(url.searchParams.get('agent') || '').toLowerCase();
        const baseUrl = `${url.protocol}//${req.headers.host || `${config.board.host}:${config.board.port}`}`;
        const agent = config.agentsById.get(agentId);
        if (!agent) {
          return text(res, 200, genericPrompt({ config, baseUrl }), 'text/plain; charset=utf-8');
        }
        return text(res, 200, joinPrompt({ agent, config, baseUrl }), 'text/plain; charset=utf-8');
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
        res.write(`event: hello\ndata: ${JSON.stringify({ protocol: SCHEMA, serverTime: localIso() })}\n\n`);
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
        const raw = await readBody(req);
        let payload;
        try {
          payload = JSON.parse(raw || '{}');
        } catch {
          return json(res, 400, { ok: false, code: 'BAD_JSON', error: '请求体不是合法 JSON。' });
        }
        const check = validateMessage(payload, { agentsById: config.agentsById, guards: config.guards });
        if (!check.ok) return json(res, 400, { ok: false, code: check.code, error: check.error });

        const agent = config.agentsById.get(check.agentId);
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
        // 发言即视为在线信号
        presence.beat(check.agentId, { state: 'online', note: '正在发言', session: payload.session });
        return json(res, 200, {
          ok: true,
          message,
          warnings: check.flags.includes('ACK_ONLY')
            ? ['本条只有寒暄、没有实质内容：被 @ 时请给结论、依据与下一步。']
            : [],
        });
      }

      // ---- 心跳 ----
      if ((pathname === '/api/heartbeat' || pathname === '/api/presence') && req.method === 'POST') {
        const raw = await readBody(req);
        let payload;
        try {
          payload = JSON.parse(raw || '{}');
        } catch {
          return json(res, 400, { ok: false, code: 'BAD_JSON', error: '请求体不是合法 JSON。' });
        }
        const agentId = String(payload.agent || '').toLowerCase();
        if (!agentId) return json(res, 400, { ok: false, code: 'MISSING_AGENT', error: '缺少 agent 字段。' });
        if (!config.agentsById.has(agentId)) {
          return json(res, 400, {
            ok: false,
            code: 'UNKNOWN_AGENT',
            error: `名册中没有成员 ${agentId}；请先在 board.config.json 登记。`,
          });
        }
        const record = presence.beat(agentId, {
          state: payload.state,
          note: payload.note,
          session: payload.session,
        });
        return json(res, 200, { ok: true, agent: agentId, lastSeen: record.lastSeen, ttlSeconds: presence.ttlSeconds });
      }

      // ---- 未知接口 ----
      if (pathname.startsWith('/api/')) {
        return json(res, 404, { ok: false, code: 'NOT_FOUND', error: `未知接口 ${pathname}` });
      }

      if (req.method !== 'GET') return text(res, 405, '只支持 GET');
      return serveStatic(res, pathname);
    } catch (err) {
      const code = err?.code || 'INTERNAL';
      const status = code === 'BODY_TOO_LARGE' ? 413 : 500;
      return json(res, status, { ok: false, code, error: err?.message || '服务端异常' });
    }
  });

  return { server, config, store, presence, statePayload };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  const { server, config, store } = createBoardServer(args);
  server.listen(config.board.port, config.board.host, () => {
    const url = `http://${config.board.host}:${config.board.port}`;
    if (!args.quiet) {
      const stats = store.stats();
      process.stdout.write(
        [
          '',
          `  ${config.board.name} · ${config.board.nameZh} 已启动`,
          `  黑板地址   ${url}`,
          `  协议       ${config.board.protocol}`,
          `  成员       ${config.agents.map((a) => a.name).join(' · ')}`,
          `  已有留言   ${stats.latestSeq} 条（镜像 ${path.relative(process.cwd(), stats.mirrorFile)}）`,
          `  一键接入   ${url} 侧栏「快速接入」按钮，或 GET /api/prompt?agent=<id>`,
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
