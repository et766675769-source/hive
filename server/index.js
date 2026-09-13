#!/usr/bin/env node
// 蜂群 HIVE · 服务端
//
// 一个本地面板：一个你，指挥一群绑定不同模型的 AI 员工。
// 零依赖，只用 Node 内置模块；数据全在本机 data/ 下。
//
// 用法：
//   node server/index.js [--port 8787] [--host 127.0.0.1] [--data-dir data]

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { Store, THREAD_MODES } from './store.js';
import { Worker } from './worker.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    const eq = raw.indexOf('=');
    const token = eq === -1 ? raw : raw.slice(0, eq);
    const inline = eq === -1 ? null : raw.slice(eq + 1);
    const take = () => (inline !== null ? inline : argv[++i]);
    if (token === '--port' || token === '-p') args.port = Number(take());
    else if (token === '--host') args.host = take();
    else if (token === '--data-dir') args.dataDir = take();
    else if (token === '--help' || token === '-h') args.help = true;
  }
  return args;
}

const argv = parseArgs(process.argv.slice(2));
if (argv.help) {
  console.log('用法：node server/index.js [--port 8787] [--host 127.0.0.1] [--data-dir data]');
  process.exit(0);
}

const config = {
  port: Number(argv.port) || Number(process.env.MB_PORT) || 8787,
  host: argv.host || process.env.MB_HOST || '127.0.0.1',
  dataDir: path.isAbsolute(argv.dataDir || '')
    ? argv.dataDir
    : path.join(ROOT, argv.dataDir || process.env.MB_DATA_DIR || 'data'),
};

const store = new Store({ dataDir: config.dataDir });

/* ── 头像库 ────────────────────────────────────────────────
   从一个目录里给员工随机挑头像；库里没图就回退到"种子 → 色相 + 首字"。
   目录按顺序找第一个有图的：环境变量 → D:\随机头像库 → 项目内 web/avatars。
   （不涉及性别之类的字段：头像纯粹是随机挑一张。）
   ─────────────────────────────────────────────────────────── */

const AVATAR_DIRS = [
  process.env.HIVE_AVATAR_DIR,
  'D:\\随机头像库',
  path.join(ROOT, 'web', 'avatars'),
].filter((dir) => typeof dir === 'string' && dir.length > 0);

const AVATAR_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

let avatarCache = { at: 0, dir: null, files: [] };

/** 扫出第一个可用的头像库（10 秒缓存，免得每次建员工都读盘）。 */
function avatarLibrary() {
  const now = Date.now();
  if (now - avatarCache.at < 10000) return avatarCache;
  for (const dir of AVATAR_DIRS) {
    try {
      const files = fs
        .readdirSync(dir)
        .filter((name) => AVATAR_EXT.has(path.extname(name).toLowerCase()))
        .sort();
      if (files.length) {
        avatarCache = { at: now, dir, files };
        return avatarCache;
      }
    } catch {
      /* 目录不存在就试下一个 */
    }
  }
  avatarCache = { at: now, dir: null, files: [] };
  return avatarCache;
}

/** 给一个新员工挑头像：库里优先随机挑，挑不到就只留种子。 */
function pickAvatar(existing) {
  const seed = existing?.avatar?.seed || Math.floor(Math.random() * 1e9);
  if (existing?.avatar?.file) return { seed, file: existing.avatar.file };
  const library = avatarLibrary();
  if (!library.files.length) return { seed };
  return { seed, file: library.files[Math.floor(Math.random() * library.files.length)] };
}

/* ── SSE：把新留言和员工忙闲实时推给面板 ─────────────────── */

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

const worker = new Worker({ store, onEvent: broadcast });

/**
 * 派活，并顺着回复里的 @点名 继续派下去。
 *
 * 这一条就是"任务自动分配"的全部机制：经理接到任务 → 他按下属职能用 @名字 分派
 * → 系统解析回复里的点名、把任务自动送给那几位下属 → 下属再各自开工。
 * 全程不需要人再转一手，也不需要任何"心跳"来发现谁该干活。
 *
 * 两道保险：链条深度≤3，且同一条链上不重复派给同一个人（防止互相 @ 转圈）。
 */
async function dispatchChain({ employeeId, mode, threadId, taskText, fromName, replyTo, depth, chain }) {
  if (depth > 3 || chain.includes(employeeId)) return;
  const nextChain = [...chain, employeeId];

  let result;
  try {
    result = await worker.dispatch({ employeeId, mode, threadId, taskText, fromName, replyTo });
  } catch (error) {
    broadcast('error', { employeeId, error: error.message });
    return;
  }
  if (!result.reply || result.error) return;

  const { employees } = store.readOrg();
  // 只认「【派活】@名字：任务」这一种格式。
  // 不能按普通 @ 触发：经理回答"介绍一下你自己"时会列出下属名字，
  // 那样一开口就把整组全叫起来了（实测踩过）。
  const assignments = worker.parseAssignments(result.reply.text, employees);
  if (!assignments.length) return;

  const me = employees.find((item) => item.id === employeeId);
  for (const item of assignments) {
    if (nextChain.includes(item.employeeId)) continue;
    broadcast('assign', { from: employeeId, fromName: me?.name || '', to: item.employeeId, task: item.task });
    void dispatchChain({
      employeeId: item.employeeId,
      mode,
      threadId,
      taskText: item.task,
      fromName: me?.name || '同事',
      replyTo: result.reply.id,
      depth: depth + 1,
      chain: nextChain,
    });
  }
}

/* ── HTTP 小工具 ─────────────────────────────────────────── */

const shortId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req, limit = 512 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function serveStatic(res, filePath) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

/* ── 组织操作（部门 / 员工 / 项目）───────────────────────── */

const LEVELS = ['manager', 'lead', 'worker'];

function normalizeEmployee(input, existing = null) {
  const name = String(input.name || '').trim().slice(0, 32);
  if (!name) throw new Error('员工名字不能为空');
  const level = LEVELS.includes(input.level) ? input.level : existing?.level || 'worker';
  return {
    id: existing?.id || input.id || shortId('e'),
    name,
    title: String(input.title || existing?.title || '员工').trim().slice(0, 32),
    level,
    departmentId: String(input.departmentId ?? existing?.departmentId ?? '').trim(),
    managerId: String(input.managerId ?? existing?.managerId ?? '').trim(),
    description: String(input.description ?? existing?.description ?? '').trim().slice(0, 500),
    model: String(input.model ?? existing?.model ?? '').trim().slice(0, 80),
    apiKey: String(input.apiKey ?? existing?.apiKey ?? '').trim().slice(0, 200),
    baseUrl: String(input.baseUrl ?? existing?.baseUrl ?? '').trim().slice(0, 200),
    // 头像：优先从头像库随机挑一张，库里没有就退回"种子 → 色相 + 首字"
    avatar: pickAvatar(existing),
    createdAt: existing?.createdAt || new Date().toISOString(),
  };
}

function normalizeDepartment(input, existing = null) {
  const name = String(input.name || '').trim().slice(0, 32);
  if (!name) throw new Error('部门名字不能为空');
  return {
    id: existing?.id || input.id || shortId('d'),
    name,
    description: String(input.description ?? existing?.description ?? '').trim().slice(0, 500),
    accent: String(input.accent ?? existing?.accent ?? '').trim().slice(0, 20),
    createdAt: existing?.createdAt || new Date().toISOString(),
  };
}

function normalizeProject(input, existing = null) {
  const name = String(input.name || '').trim().slice(0, 48);
  if (!name) throw new Error('项目名字不能为空');
  const departmentIds = Array.isArray(input.departmentIds) ? input.departmentIds : existing?.departmentIds || [];
  const employeeIds = Array.isArray(input.employeeIds) ? input.employeeIds : existing?.employeeIds || [];
  return {
    id: existing?.id || input.id || shortId('p'),
    name,
    description: String(input.description ?? existing?.description ?? '').trim().slice(0, 800),
    status: String(input.status ?? existing?.status ?? '进行中').trim().slice(0, 16),
    departmentIds: departmentIds.map(String),
    employeeIds: employeeIds.map(String),
    createdAt: existing?.createdAt || new Date().toISOString(),
  };
}

/* ── 路由 ────────────────────────────────────────────────── */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = decodeURIComponent(url.pathname);

  try {
    /* ---- 头像文件：从头像库里直接发给前端 / 桌面端 ---- */
    if (pathname.startsWith('/api/avatar/') && req.method === 'GET') {
      const name = decodeURIComponent(pathname.slice('/api/avatar/'.length));
      const library = avatarLibrary();
      if (!library.dir || !library.files.includes(name) || name.includes('..')) {
        return json(res, 404, { ok: false, error: '头像库里没有这个文件' });
      }
      return serveStatic(res, path.join(library.dir, name));
    }

    /* ---- 实时流 ---- */
    if (pathname === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, at: new Date().toISOString() })}\n\n`);
      clients.add(res);
      const keepAlive = setInterval(() => {
        try {
          res.write(`event: ping\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
        } catch {
          clearInterval(keepAlive);
        }
      }, 20000);
      req.on('close', () => {
        clearInterval(keepAlive);
        clients.delete(res);
      });
      return undefined;
    }

    /* ---- 全量状态 ---- */
    if (pathname === '/api/state' && req.method === 'GET') {
      const org = store.readOrg();
      const { projects } = store.readProjects();
      const settings = store.readSettings();
      return json(res, 200, {
        ok: true,
        settings: {
          hasKey: Boolean(String(settings.apiKey || '').trim()),
          baseUrl: settings.baseUrl,
          model: settings.model,
          onboarded: Boolean(settings.onboarded),
        },
        departments: org.departments,
        employees: org.employees.map((employee) => ({
          ...employee,
          // 不把 Key 回传给前端，只回一个"有没有"
          apiKey: undefined,
          hasOwnKey: Boolean(String(employee.apiKey || '').trim()),
          channel: store.channelFor(employee),
        })),
        projects,
        busy: worker.busyIds(),
        summary: store.summary(),
        avatar: (() => {
          const library = avatarLibrary();
          return { dir: library.dir, count: library.files.length };
        })(),
      });
    }

    /* ---- 读线程 ---- */
    if (pathname === '/api/thread' && req.method === 'GET') {
      const mode = String(url.searchParams.get('mode') || 'department');
      const id = String(url.searchParams.get('id') || '');
      if (!THREAD_MODES.includes(mode)) return json(res, 400, { ok: false, error: `未知面板模式：${mode}` });
      return json(res, 200, { ok: true, mode, id, messages: store.readThread(mode, id) });
    }

    /* ---- 发消息（人说话 → 可能触发员工）---- */
    if (pathname === '/api/message' && req.method === 'POST') {
      const payload = await readJson(req);
      const mode = String(payload.mode || 'department');
      const threadId = String(payload.threadId || '');
      const text = String(payload.text || '').trim();
      if (!THREAD_MODES.includes(mode)) return json(res, 400, { ok: false, error: `未知面板模式：${mode}` });
      if (!threadId) return json(res, 400, { ok: false, error: '缺少 threadId' });
      if (!text) return json(res, 400, { ok: false, error: '消息不能为空' });

      const message = {
        id: `m_${randomUUID().slice(0, 8)}`,
        at: new Date().toISOString(),
        mode,
        threadId,
        from: 'local',
        fromName: '你',
        kind: 'message',
        status: 'done',
        replyTo: null,
        text,
      };
      store.appendMessage(mode, threadId, message);
      broadcast('message', message);

      const { employees } = store.readOrg();
      let targets = worker.parseMentions(text, employees);
      // 员工面板里说话 = 直接派给他（不必写 @）
      if (!targets.length && mode === 'employee' && employees.some((item) => item.id === threadId)) {
        targets = [threadId];
      }
      // 只派给这个线程相关的人：部门/项目面板里未点名的员工不响应
      const started = [];
      for (const employeeId of targets) {
        started.push(employeeId);
        void dispatchChain({ employeeId, mode, threadId, taskText: text, fromName: '你', replyTo: message.id, depth: 0, chain: [] });
      }
      return json(res, 200, { ok: true, message, dispatched: started });
    }

    /* ---- 全局 API 通道 ---- */
    if (pathname === '/api/settings' && req.method === 'POST') {
      const payload = await readJson(req);
      const current = store.readSettings();
      const next = store.writeSettings({
        apiKey: payload.apiKey === undefined ? current.apiKey : String(payload.apiKey).trim().slice(0, 200),
        baseUrl: payload.baseUrl === undefined ? current.baseUrl : String(payload.baseUrl).trim().slice(0, 200),
        model: payload.model === undefined ? current.model : String(payload.model).trim().slice(0, 80),
        onboarded: payload.onboarded === undefined ? current.onboarded : Boolean(payload.onboarded),
      });
      return json(res, 200, {
        ok: true,
        settings: { hasKey: Boolean(next.apiKey), baseUrl: next.baseUrl, model: next.model, onboarded: next.onboarded },
      });
    }

    /* ---- 部门 ---- */
    if (pathname === '/api/department' && req.method === 'POST') {
      const payload = await readJson(req);
      const org = store.readOrg();
      const existing = payload.id ? org.departments.find((item) => item.id === payload.id) : null;
      const department = normalizeDepartment(payload, existing);
      const list = existing
        ? org.departments.map((item) => (item.id === department.id ? department : item))
        : [...org.departments, department];
      store.writeOrg({ ...org, departments: list });
      broadcast('org', { kind: 'department' });
      return json(res, 200, { ok: true, department });
    }
    if (pathname === '/api/department/delete' && req.method === 'POST') {
      const payload = await readJson(req);
      const org = store.readOrg();
      const id = String(payload.id || '');
      store.writeOrg({
        departments: org.departments.filter((item) => item.id !== id),
        // 部门没了，员工不删，只是脱离部门（避免误删人）
        employees: org.employees.map((item) => (item.departmentId === id ? { ...item, departmentId: '' } : item)),
      });
      const data = store.readProjects();
      store.writeProjects({
        projects: data.projects.map((project) => ({
          ...project,
          departmentIds: (project.departmentIds || []).filter((item) => item !== id),
        })),
      });
      broadcast('org', { kind: 'department-delete', id });
      return json(res, 200, { ok: true });
    }

    /* ---- 员工 ---- */
    if (pathname === '/api/employee' && req.method === 'POST') {
      const payload = await readJson(req);
      const org = store.readOrg();
      const existing = payload.id ? org.employees.find((item) => item.id === payload.id) : null;
      const employee = normalizeEmployee(payload, existing);
      const list = existing
        ? org.employees.map((item) => (item.id === employee.id ? employee : item))
        : [...org.employees, employee];
      store.writeOrg({ ...org, employees: list });
      broadcast('org', { kind: 'employee' });
      return json(res, 200, { ok: true, employee: { ...employee, apiKey: undefined, hasOwnKey: Boolean(employee.apiKey) } });
    }
    if (pathname === '/api/employee/delete' && req.method === 'POST') {
      const payload = await readJson(req);
      const org = store.readOrg();
      const id = String(payload.id || '');
      store.writeOrg({ ...org, employees: org.employees.filter((item) => item.id !== id) });
      const data = store.readProjects();
      store.writeProjects({
        projects: data.projects.map((project) => ({
          ...project,
          employeeIds: (project.employeeIds || []).filter((item) => item !== id),
        })),
      });
      broadcast('org', { kind: 'employee-delete', id });
      return json(res, 200, { ok: true });
    }

    /* ---- 项目 ---- */
    if (pathname === '/api/project' && req.method === 'POST') {
      const payload = await readJson(req);
      const data = store.readProjects();
      const existing = payload.id ? data.projects.find((item) => item.id === payload.id) : null;
      const project = normalizeProject(payload, existing);
      const list = existing
        ? data.projects.map((item) => (item.id === project.id ? project : item))
        : [...data.projects, project];
      store.writeProjects({ projects: list });
      broadcast('org', { kind: 'project' });
      return json(res, 200, { ok: true, project });
    }
    if (pathname === '/api/project/delete' && req.method === 'POST') {
      const payload = await readJson(req);
      const data = store.readProjects();
      const id = String(payload.id || '');
      store.writeProjects({ projects: data.projects.filter((item) => item.id !== id) });
      broadcast('org', { kind: 'project-delete', id });
      return json(res, 200, { ok: true });
    }

    /* ---- 静态资源 ---- */
    if (req.method === 'GET' || req.method === 'HEAD') {
      const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const filePath = path.join(ROOT, 'web', rel);
      // 防越权：只允许 web/ 下的文件
      if (!filePath.startsWith(path.join(ROOT, 'web'))) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('403');
      }
      return serveStatic(res, filePath);
    }

    return json(res, 404, { ok: false, error: `无此接口：${req.method} ${pathname}` });
  } catch (error) {
    return json(res, 500, { ok: false, error: error.message });
  }
});

server.listen(config.port, config.host, () => {
  const url = `http://${config.host}:${config.port}`;
  console.log('');
  console.log('  蜂群 HIVE 已启动');
  console.log(`  面板       ${url}`);
  console.log(`  数据目录   ${config.dataDir}`);
  console.log('');
});
