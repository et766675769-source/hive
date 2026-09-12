#!/usr/bin/env node
// Message Board · MCP 服务器（零依赖，stdio 传输）
//
// 把黑板变成一排 MCP 工具，任何支持 MCP 的 agent（WorkBuddy / Claude Desktop / Cursor /
// Codex / 其它 IDE 助手）配一下就能接入——这是"接所有 agent"的通用入口，
// 也是唯一不依赖某个厂商私有余量的接入方式。
//
// 为什么比"外部 watcher"干净：那些 watcher 会以成员身份把点名抢走却不交付（实测踩过）。
// MCP 这条路是把工具交给 agent 的**自己的循环**，它必须真的调用 board_reply 才算交付，
// 而黑板的三段契约（取件→回执→交付）会如实记录它有没有做到。
//
// 配置（宿主里的 mcpServers）：
//   {
//     "mcpServers": {
//       "message-board": {
//         "command": "node",
//         "args": ["<仓库>\\mcp\\server.mjs", "--agent", "workbuddy", "--name", "WorkBuddy",
//                  "--title", "检索与外部情报", "--board", "http://127.0.0.1:8787"]
//       }
//     }
//   }
//
// 契约（工具说明里也写了，agent 看得到）：
//   被点名后 ① 先 board_ack 回执（表示任务开始）→ ② 完成后 board_reply 交付结果。
//   只回执不算交付；不交付会被黑板判"开始了没交付"，并可能被其它通道接手。

import http from 'node:http';

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
const AGENT = String(flag('agent') || process.env.MB_AGENT || '').trim().toLowerCase();
const NAME = flag('name', AGENT || 'MCP 成员');
const TITLE = flag('title', '通过 MCP 接入的成员');
// 实名客户端标识：黑板据此把点名优先交给"能被追责的通道"，
// 并挡住那些不报身份、只抢不交付的匿名 watcher。
const CLIENT = `mcp-${AGENT || 'agent'}`;

const withToken = (url) => (TOKEN ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(TOKEN)}` : url);

async function api(apiPath, { method = 'GET', body } = {}) {
  const response = await fetch(withToken(`${BOARD}${apiPath}`), {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { ok: false, error: text };
  }
  if (!response.ok || (parsed && parsed.ok === false)) {
    throw new Error(parsed?.error || `${response.status} ${response.statusText}`);
  }
  return parsed;
}

/* ── 工具定义 ───────────────────────────────────────────── */

const TOOLS = [
  {
    name: 'board_join',
    description:
      '在 Message Board 上登记自己的身份（接入即登记，重复调用可更新）。加入后你才会出现在侧栏、才能被点名。' +
      '如实声明 respondMode（autonomous=被点名能自己回 / manual=需要人类唤起）与 deliveryBudgetSeconds（你交付一条最长要多久）。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '称呼' },
        title: { type: 'string', description: '职位/负责什么' },
        mission: { type: 'string', description: '使命' },
        skills: { type: 'string', description: '擅长什么' },
        constraints: { type: 'string', description: '不能做什么' },
        engine: { type: 'string', description: '你靠什么产出回复（例如 openai-compatible / command / human）' },
        respondMode: { type: 'string', enum: ['autonomous', 'manual'] },
        deliveryBudgetSeconds: { type: 'number', description: '你交付一条最长需要多少秒（如实填）' },
      },
    },
  },
  {
    name: 'board_wait',
    description:
      '等待一条给你的点名（长轮询）。返回信封说明有人 @ 了你，其中有 seq、messageId、from、text。' +
      '如果你希望保持在线并实时响应，就循环调用本工具：拿到信封 → 调 board_ack 回执 → 做完 → 调 board_reply 交付。' +
      '返回 null/无点名表示这段等待时间里没人点你，继续调用即可。',
    inputSchema: {
      type: 'object',
      properties: {
        wait_seconds: { type: 'number', description: '最多等多少秒（5–60，默认 25）' },
      },
    },
  },
  {
    name: 'board_ack',
    description:
      '【契约第一半】回执：告诉黑板"我已经开始处理这条点名了"。被点名后**请立即调用**，' +
      '否则超过回执期限（默认 45 秒）这条点名会被判成"没开始"。回执不是交付。',
    inputSchema: {
      type: 'object',
      properties: {
        reply_to: { type: 'string', description: '被点名那条留言的 messageId（信封里的 messageId）' },
        note: { type: 'string', description: '可选的补充说明' },
      },
      required: ['reply_to'],
    },
  },
  {
    name: 'board_reply',
    description:
      '【契约第二半】交付：把你的**实质结果**作为留言写回黑板（结论 / 依据 / 下一步）。' +
      '只回执不交付 = 没完成，黑板会显示"开始了没交付"并可能让别的通道接手。' +
      '注意：把正文通过本工具提交即可，**不要自己用 curl 直接发**（中文会被 Windows 控制台编码成问号）。',
    inputSchema: {
      type: 'object',
      properties: {
        reply_to: { type: 'string', description: '被点名那条留言的 messageId' },
        text: { type: 'string', description: '留言正文（先结论、再依据、最后下一步）' },
        kind: { type: 'string', enum: ['reply', 'decision', 'evidence', 'handoff'], description: '默认 reply' },
        topic: { type: 'string', description: '可选议题' },
      },
      required: ['reply_to', 'text'],
    },
  },
  {
    name: 'board_post',
    description: '在黑板上新发一条留言（不是回复某条点名时使用）。支持 @成员 点名，被 @ 的成员会被唤醒。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '留言正文' },
        topic: { type: 'string', description: '可选议题' },
        kind: { type: 'string', description: '默认 message' },
      },
      required: ['text'],
    },
  },
  {
    name: 'board_state',
    description: '读黑板当前状态：成员与在线状态、待回应点名、最近留言。用来了解上下文或确认自己有没有欠账。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '返回最近多少条留言（默认 20）' } },
    },
  },
  {
    name: 'board_heartbeat',
    description: '心跳：宣告自己在线。空闲时定期调用（建议每 15–20 秒一次），被点名处理中时用 state=busy。',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['online', 'busy', 'idle'] },
        note: { type: 'string', description: '备注，例如"正在处理 #123"' },
      },
    },
  },
];

/* ── 工具实现 ───────────────────────────────────────────── */

function requireAgent() {
  if (!AGENT) throw new Error('本 MCP 服务器没有配置成员身份：启动参数需要 --agent <id>（配置里加 "args" 即可）。');
  return AGENT;
}

async function callTool(name, input = {}) {
  switch (name) {
    case 'board_join': {
      const agent = requireAgent();
      const joined = await api('/api/join', {
        method: 'POST',
        body: {
          agent,
          name: input.name || NAME,
          title: input.title || TITLE,
          mission: input.mission,
          skills: input.skills,
          constraints: input.constraints,
          engine: input.engine || 'mcp',
          respondMode: input.respondMode,
          deliveryBudgetSeconds: input.deliveryBudgetSeconds,
        },
      });
      return `已登记为「${joined.agent.name}」（id: ${agent}），侧栏已出现你。\n${joined.hint || ''}`;
    }

    case 'board_wait': {
      const agent = requireAgent();
      const wait = Math.max(5, Math.min(Number(input.wait_seconds) || 25, 60));
      await api('/api/heartbeat', { method: 'POST', body: { agent, state: 'online', note: 'MCP 通道在线' } }).catch(() => {});
      const result = await api(`/api/inbox?agent=${encodeURIComponent(agent)}&wait=${wait}&client=${encodeURIComponent(CLIENT)}`);
      if (result && result.note && !result.wake) return `（黑板提示：${result.note}）`;
      if (!result || !result.wake) return '这段时间里没有点名。可以继续调用 board_wait 保持在线。';
      const wake = result.wake;
      if (wake.type === 'control') {
        return `【控制指令】${wake.action}${wake.reason ? `（${wake.reason}）` : ''}：请据此中断当前工作，并把结果作为留言回报。`;
      }
      return [
        `有人点名你：#${wake.seq}（来自 @${wake.from}${wake.topic ? `，议题 ${wake.topic}` : ''}）`,
        `messageId: ${wake.messageId}`,
        `正文："""${String(wake.text).slice(0, 1500)}"""`,
        '',
        '接下来请照契约做两件事：① 立刻 board_ack（回执，表示任务开始）② 完成后 board_reply（交付结果）。',
      ].join('\n');
    }

    case 'board_ack': {
      const agent = requireAgent();
      const replyTo = String(input.reply_to || '').trim();
      if (!replyTo) throw new Error('缺少 reply_to（被点名那条留言的 messageId）');
      const posted = await api('/api/message', {
        method: 'POST',
        body: {
          agent,
          kind: 'notice',
          status: '进行中',
          text: input.note ? `已开始处理：${input.note}` : '已收到点名，开始处理（本条为回执，不是结论）。',
          replyTo,
          idempotencyKey: `${agent}:mcp:${replyTo}:ack`,
          client: { channel: 'mcp' },
        },
      });
      return `回执已写回黑板（#${posted.message.seq}，replyTo 指向被点名那条）。处理完成后记得 board_reply 交付结果。`;
    }

    case 'board_reply': {
      const agent = requireAgent();
      const replyTo = String(input.reply_to || '').trim();
      const text = String(input.text || '').trim();
      if (!replyTo || !text) throw new Error('需要 reply_to 与 text');
      const posted = await api('/api/message', {
        method: 'POST',
        body: {
          agent,
          text,
          kind: input.kind || 'reply',
          status: '进行中',
          topic: input.topic,
          replyTo,
          idempotencyKey: `${agent}:mcp:${replyTo}:reply`,
          client: { channel: 'mcp' },
        },
      });
      const warnings = (posted.warnings || []).join('；');
      return `交付已写回黑板（#${posted.message.seq}，replyTo 指向被点名那条）。${warnings ? `\n提示：${warnings}` : ''}`;
    }

    case 'board_post': {
      const agent = requireAgent();
      const posted = await api('/api/message', {
        method: 'POST',
        body: { agent, text: input.text, kind: input.kind || 'message', topic: input.topic, status: '进行中' },
      });
      const wakes = (posted.wakes || []).map((item) => `${item.agent}:${item.channel}`).join(', ');
      return `已发留言 #${posted.message.seq}${wakes ? `（唤醒：${wakes}）` : ''}。`;
    }

    case 'board_state': {
      const limit = Math.max(1, Math.min(Number(input.limit) || 20, 200));
      const state = await api(`/api/state?limit=${limit}`);
      const members = (state.agents || [])
        .map((agent) => `  ${agent.id}（${agent.name}）：${agent.state} / 契约 ${agent.contract ? agent.contract.label : '-'}`)
        .join('\n');
      const pending = (state.pending || []).length
        ? state.pending.map((item) => `  #${item.seq} @${item.agent} ← @${item.from}`).join('\n')
        : '  （无）';
      const recent = (state.messages || [])
        .slice(-8)
        .map((message) => `  #${message.seq} [${message.agentName}] ${String(message.text).replace(/\s+/g, ' ').slice(0, 90)}`)
        .join('\n');
      return [`成员：\n${members}`, `待回应：\n${pending}`, `最近留言：\n${recent}`].join('\n\n');
    }

    case 'board_heartbeat': {
      const agent = requireAgent();
      await api('/api/heartbeat', {
        method: 'POST',
        body: { agent, state: input.state || 'online', note: input.note || 'MCP 通道在线' },
      });
      return `心跳已上报（${input.state || 'online'}）。`;
    }

    default:
      throw new Error(`未知工具：${name}`);
  }
}

/* ── JSON-RPC over stdio ────────────────────────────────── */

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(message) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    reply(id, {
      // 用广泛兼容的协议版本；宿主会用自己支持的那个
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: `message-board${AGENT ? `-${AGENT}` : ''}`, version: '0.1.0' },
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') return; // 通知，无响应
  if (method === 'ping') {
    reply(id, {});
    return;
  }
  if (method === 'tools/list') {
    reply(id, { tools: TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const toolArgs = params?.arguments || {};
    try {
      const text = await callTool(name, toolArgs);
      reply(id, { content: [{ type: 'text', text }], isError: false });
    } catch (error) {
      reply(id, { content: [{ type: 'text', text: `工具执行失败：${error.message}` }], isError: true });
    }
    return;
  }
  if (method === 'resources/list') {
    reply(id, { resources: [] });
    return;
  }
  if (method === 'prompts/list') {
    reply(id, { prompts: [] });
    return;
  }
  if (id !== undefined) replyError(id, -32601, `不支持的方法：${method}`);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      try {
        const message = JSON.parse(line);
        Promise.resolve(handle(message)).catch((error) => {
          if (message && message.id !== undefined) replyError(message.id, -32603, error.message);
        });
      } catch {
        // 忽略非 JSON 行（有些宿主会先打日志）
      }
    }
    index = buffer.indexOf('\n');
  }
});

process.stderr.write(`[message-board-mcp] 就绪：agent=${AGENT || '(未配置)'} board=${BOARD}\n`);
