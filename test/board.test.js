// Message Board · 协议与接口测试（node:test，无第三方依赖）
//
// 运行：npm test
// 若临时目录不可写，可用 MB_TEST_DATA_DIR 指定一个可写目录。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBoardServer } from '../server/index.js';
import { Registry } from '../server/registry.js';
import { isAcknowledgementOnly, parseMentions, localIso, stripBom } from '../server/protocol.js';

const dataRoot = process.env.MB_TEST_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'message-board-test-'));
fs.mkdirSync(dataRoot, { recursive: true });

async function withBoard(run, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(dataRoot, 'board-'));
  const { server, config, store, presence, registry } = createBoardServer({ dataDir, quiet: true, ...overrides });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (apiPath, body) =>
    fetch(`${base}${apiPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const state = async (query = '?limit=50') => (await fetch(`${base}/api/state${query}`)).json();
  const join = (identity) => post('/api/join', identity);
  try {
    await run({ base, dataDir, config, store, presence, registry, post, state, join });
  } finally {
    presence.stop();
    await new Promise((resolve) => server.close(resolve));
  }
}

/* ── 纯函数 ─────────────────────────────────────────────── */

test('纯函数：@ 提及只认可已登记的成员', () => {
  assert.deepEqual(parseMentions('@codex 请看 @ghost', ['codex', 'claude']), ['codex']);
  assert.deepEqual(parseMentions('没有提及', ['codex']), []);
});

test('纯函数：只有寒暄的回复被判为空话', () => {
  const tokens = ['收到', '好的', 'ok'];
  assert.equal(isAcknowledgementOnly('收到', tokens), true);
  assert.equal(isAcknowledgementOnly('  好的。 ', tokens), true);
  assert.equal(isAcknowledgementOnly('收到，我核对了三项并复现了问题', tokens), false);
});

test('纯函数：成员 id 规则与本地时区时间戳', () => {
  assert.equal(Registry.isValidId('codex'), true);
  assert.equal(Registry.isValidId('claude-3'), true);
  assert.equal(Registry.isValidId('Codex'), true, '大小写不敏感，会被归一化为 codex');
  assert.equal(Registry.normalizeId('  Codex  '), 'codex');
  assert.equal(Registry.isValidId('a'), false, '至少 2 位');
  assert.equal(Registry.isValidId('codex cli'), false, '不允许空格');
  assert.equal(Registry.isValidId('@x'), false, '不允许 @');
  assert.equal(Registry.isValidId(''), false);
  assert.match(localIso(new Date(2026, 8, 10, 21, 0, 0)), /^2026-09-10T21:00:00[+-]\d{2}:\d{2}$/);
});

test('纯函数：带 BOM 的文本被正确剥离', () => {
  assert.equal(stripBom('\uFEFF{"a":1}'), '{"a":1}');
});

/* ── 探活与初始状态 ─────────────────────────────────────── */

test('初始黑板没有预置成员', async () => {
  await withBoard(async ({ base, state }) => {
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.protocol, 'messageboard.protocol.v1');

    const payload = await state();
    assert.deepEqual(payload.agents, [], '侧栏初始为空，成员由接入产生');
    assert.equal(payload.presence.total, 0);
    assert.deepEqual(payload.messages, []);
  });
});

/* ── 接入即登记 ─────────────────────────────────────────── */

test('接入：POST /api/join 自述身份后出现在名册', async () => {
  await withBoard(async ({ join, state, dataDir }) => {
    const response = await join({
      agent: 'codex',
      name: 'Codex',
      platform: 'Codex CLI',
      title: '项目主 Agent',
      mission: '目标拆解与代码实现',
      skills: '重构、测试',
      constraints: '不臆断未验证的事实',
    });
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.agent.id, 'codex');
    assert.equal(body.agent.name, 'Codex');

    const payload = await state();
    assert.equal(payload.agents.length, 1);
    assert.equal(payload.agents[0].name, 'Codex');
    assert.equal(payload.agents[0].title, '项目主 Agent');
    assert.equal(payload.agents[0].state, 'online', '登记即视为一次心跳');
    assert.equal(payload.agents[0].selfDeclared, true);

    // 登记表落盘
    const file = JSON.parse(fs.readFileSync(path.join(dataDir, 'agents.json'), 'utf8'));
    assert.equal(file.agents.length, 1);
    assert.equal(file.agents[0].id, 'codex');
  });
});

test('接入：成员按接入顺序向下排列，重复接入更新身份', async () => {
  await withBoard(async ({ join, state }) => {
    await join({ agent: 'codex', name: 'Codex', title: '项目主 Agent' });
    await join({ agent: 'claude', name: 'Claude', title: '评审 Agent' });
    let payload = await state();
    assert.deepEqual(payload.agents.map((a) => a.id), ['codex', 'claude']);

    await join({ agent: 'gemini', name: 'Gemini', title: '调研 Agent' });
    payload = await state();
    assert.deepEqual(payload.agents.map((a) => a.id), ['codex', 'claude', 'gemini']);

    await join({ agent: 'codex', name: 'Codex', title: '项目主 Agent（已更新）' });
    payload = await state();
    assert.deepEqual(payload.agents.map((a) => a.id), ['codex', 'claude', 'gemini'], '更新身份不改变顺序');
    assert.equal(payload.agents[0].title, '项目主 Agent（已更新）');
  });
});

test('接入：非法 id 被拒', async () => {
  await withBoard(async ({ join }) => {
    for (const id of ['a', 'codex cli', '@x', '', 'x'.repeat(40)]) {
      const response = await join({ agent: id, name: id });
      assert.equal(response.status, 400, JSON.stringify(id));
      assert.equal((await response.json()).code, 'BAD_AGENT_ID');
    }
  });
});

test('接入：id 大小写不敏感，Codex 与 codex 是同一个成员', async () => {
  await withBoard(async ({ join, state }) => {
    await join({ agent: 'Codex', name: 'Codex', title: '项目主 Agent' });
    const payload = await state();
    assert.equal(payload.agents.length, 1);
    assert.equal(payload.agents[0].id, 'codex');

    await join({ agent: 'codex', name: 'Codex', title: '项目主 Agent（更新）' });
    const again = await state();
    assert.equal(again.agents.length, 1, '不会因为大小写不同而出现第二个成员');
    assert.equal(again.agents[0].title, '项目主 Agent（更新）');
  });
});

test('接入：只发心跳的成员被登记为最小身份，并标记未自述', async () => {
  await withBoard(async ({ post, state }) => {
    const beat = await post('/api/heartbeat', { agent: 'quicktest' });
    const body = await beat.json();
    assert.equal(body.ok, true);
    assert.equal(body.selfDeclared, false);

    const payload = await state();
    assert.equal(payload.agents.length, 1);
    assert.equal(payload.agents[0].id, 'quicktest');
    assert.equal(payload.agents[0].name, 'quicktest');
    assert.equal(payload.agents[0].selfDeclared, false);
  });
});

test('接入：未登记也能直接发言（自动登记）', async () => {
  await withBoard(async ({ post, state }) => {
    const created = await (await post('/api/message', { agent: 'newcomer', text: '我直接来了。' })).json();
    assert.equal(created.ok, true);
    assert.equal(created.message.agent, 'newcomer');
    const payload = await state();
    assert.equal(payload.agents[0].id, 'newcomer');
    assert.equal(payload.agents[0].state, 'online', '发言即视为一次心跳');
  });
});

/* ── 留言校验 ───────────────────────────────────────────── */

test('留言：非法输入被逐条拒绝', async () => {
  await withBoard(async ({ join, post }) => {
    await join({ agent: 'codex', name: 'Codex' });
    const cases = [
      [{ agent: 'codex', text: '' }, 'EMPTY_TEXT'],
      [{ agent: 'codex', text: '正文', status: '已完成' }, 'BAD_STATUS'],
      [{ agent: 'codex', text: '正文', kind: 'unknown-kind' }, 'BAD_KIND'],
      [{ agent: 'codex', text: 'key = sk-abcdefghijklmnopqrstuvwx' }, 'SUSPECTED_SECRET'],
      [{ text: '没有 agent' }, 'MISSING_AGENT'],
    ];
    for (const [payload, code] of cases) {
      const response = await post('/api/message', payload);
      assert.equal(response.status, 400, JSON.stringify(payload));
      assert.equal((await response.json()).code, code);
    }
  });
});

test('留言：写入成功并落到 JSONL 与 markdown 镜像', async () => {
  await withBoard(async ({ join, post, state, dataDir }) => {
    await join({ agent: 'codex', name: 'Codex', title: '项目主 Agent' });
    const body = await (
      await post('/api/message', { agent: 'codex', text: '结论：黑板可用。', topic: 'T-01', status: '进行中' })
    ).json();
    assert.equal(body.ok, true);
    assert.equal(body.message.seq, 1);
    assert.equal(body.message.agentName, 'Codex');

    const payload = await state();
    assert.equal(payload.topics[0].topic, 'T-01');

    const jsonl = fs.readFileSync(path.join(dataDir, 'messages.jsonl'), 'utf8').trim().split('\n');
    assert.equal(jsonl.length, 1);
    assert.match(fs.readFileSync(path.join(dataDir, 'WORKCHAT.md'), 'utf8'), /Codex/);
  });
});

/* ── 点名与待回应 ───────────────────────────────────────── */

test('点名：空话回复被标记，实质回复消除待回应', async () => {
  await withBoard(async ({ join, post, state }) => {
    await join({ agent: 'deepseek', name: 'DeepSeek', title: '本地 Harness Agent' });
    await join({ agent: 'codex', name: 'Codex', title: '项目主 Agent' });

    const asked = await (
      await post('/api/message', { agent: 'deepseek', text: '@codex 请确认黑板可用性', topic: 'T-01' })
    ).json();

    let payload = await state();
    assert.deepEqual(payload.pending.map((item) => item.agent), ['codex']);
    assert.equal(payload.agents.find((a) => a.id === 'codex').pending, 1);

    const ack = await (await post('/api/message', { agent: 'codex', text: '收到', topic: 'T-01' })).json();
    assert.deepEqual(ack.message.flags, ['ACK_ONLY']);
    assert.equal(ack.warnings.length, 1);

    payload = await state();
    assert.equal(payload.pending.length, 1, '空话回复不应消除待回应');

    await post('/api/message', {
      agent: 'codex',
      text: '已确认：探活 200，写入成功。',
      topic: 'T-01',
      replyTo: asked.message.id,
    });
    payload = await state();
    assert.equal(payload.pending.length, 0);
    assert.equal(payload.agents.find((a) => a.id === 'codex').pending, 0);
  });
});

/* ── 本地操作员 ─────────────────────────────────────────── */

test('本地操作员：不出现在名册，但可以留言', async () => {
  await withBoard(async ({ post, state }) => {
    const body = await (await post('/api/message', { agent: 'local', text: '本机留言。' })).json();
    assert.equal(body.ok, true);
    assert.equal(body.message.agentName, '本地');

    const payload = await state();
    assert.deepEqual(payload.agents, [], '本地操作员是隐藏成员，不进名册');
    assert.equal(payload.presence.total, 0);
    assert.equal(payload.messages.length, 1);
    assert.equal(payload.board.localAgentId, 'local');
  });
});

/* ── 接入提示词 ─────────────────────────────────────────── */

test('提示词：未登记 id 得到含登记步骤的自述模板', async () => {
  await withBoard(async ({ base }) => {
    const response = await fetch(`${base}/api/prompt?agent=claude&name=Claude&title=%E8%AF%84%E5%AE%A1%20Agent`);
    const text = await response.text();
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.match(text, /身份：Claude · id: claude/);
    assert.match(text, /POST http:\/\/127\.0\.0\.1:\d+\/api\/join/);
    assert.match(text, /接入即登记|侧栏立刻出现你/);
    assert.match(text, /被 @ 必须实质回复/);
    assert.match(text, /Message Board 留言/);
  });
});

test('提示词：已登记成员拿到自己已填的身份', async () => {
  await withBoard(async ({ join, base }) => {
    await join({ agent: 'codex', name: 'Codex', title: '项目主 Agent', platform: 'Codex CLI' });
    const text = await (await fetch(`${base}/api/prompt?agent=codex`)).text();
    assert.match(text, /平台：Codex CLI/);
    assert.match(text, /职位：项目主 Agent/);
  });
});

/* ── 闭合接入 ───────────────────────────────────────────── */

test('关闭自助接入时，未登记成员被拒绝', async () => {
  const configPath = path.join(dataRoot, `closed-${Date.now()}.json`);
  fs.writeFileSync(
    configPath,
    JSON.stringify({ board: { openJoin: false }, agents: [{ id: 'preset', name: '预置成员' }] }),
    'utf8',
  );
  const previous = process.env.MB_CONFIG;
  process.env.MB_CONFIG = configPath;
  try {
    await withBoard(async ({ post, state }) => {
      const beat = await post('/api/heartbeat', { agent: 'stranger' });
      assert.equal(beat.status, 400);
      assert.equal((await beat.json()).code, 'UNKNOWN_AGENT');

      const ok = await post('/api/heartbeat', { agent: 'preset' });
      assert.equal(ok.status, 200);

      const payload = await state();
      assert.deepEqual(payload.agents.map((a) => a.id), ['preset']);
    });
  } finally {
    if (previous === undefined) delete process.env.MB_CONFIG;
    else process.env.MB_CONFIG = previous;
  }
});

test('点名：处理中通知（kind=notice）不算实质回应', async () => {
  await withBoard(async ({ join, post, state }) => {
    await join({ agent: 'deepseek', name: 'DeepSeek' });
    await join({ agent: 'codex', name: 'Codex' });

    const asked = await (await post('/api/message', { agent: 'deepseek', text: '@codex 请立刻处理' })).json();
    await post('/api/message', {
      agent: 'codex',
      kind: 'notice',
      text: '已收到点名，正在生成回复（本条为处理中通知，不是结论）。',
      replyTo: asked.message.id,
    });

    let payload = await state();
    assert.equal(payload.pending.length, 1, '处理中通知不应消除待回应');
    assert.equal(payload.agents.find((a) => a.id === 'codex').pending, 1);

    await post('/api/message', { agent: 'codex', kind: 'reply', text: '结论：已完成处理。', replyTo: asked.message.id });
    payload = await state();
    assert.equal(payload.pending.length, 0, '实质回复才消除待回应');
  });
});

/* ── 点名唤醒 ───────────────────────────────────────────── */

test('唤醒：挂着长轮询的成员被 @ 时立刻收到点名信封', async () => {
  await withBoard(async ({ base, join, post }) => {
    await join({ agent: 'deepseek', name: 'DeepSeek' });
    await join({ agent: 'codex', name: 'Codex', title: '项目主 Agent' });

    // 成员先挂上长轮询（等待 5 秒）
    const waiting = fetch(`${base}/api/inbox?agent=codex&wait=5`).then((r) => r.json());
    await new Promise((resolve) => setTimeout(resolve, 200));

    const started = Date.now();
    const sent = await (
      await post('/api/message', { agent: 'deepseek', text: '@codex 请立刻确认黑板可用性', topic: 'T-09' })
    ).json();
    const elapsed = Date.now() - started;

    assert.equal(sent.wakes.length, 1);
    assert.equal(sent.wakes[0].channel, 'inbox', '有点名时应当走长轮询通道');
    assert.equal(sent.wakes[0].ok, true);
    assert.ok(elapsed < 3000, `写入不应被唤醒拖慢（实测 ${elapsed}ms）`);

    const received = await waiting;
    assert.ok(received.wake, '长轮询应当立刻返回点名');
    assert.equal(received.source, 'inbox');
    assert.equal(received.wake.type, 'mention');
    assert.equal(received.wake.agent, 'codex');
    assert.equal(received.wake.from, 'deepseek');
    assert.equal(received.wake.messageId, sent.message.id);
    assert.equal(received.wake.seq, sent.message.seq);
    assert.match(received.wake.next, /replyTo/);
  });
});

test('唤醒：没有监听通道时入队，下次轮询取走', async () => {
  await withBoard(async ({ base, join, post }) => {
    await join({ agent: 'deepseek', name: 'DeepSeek' });
    await join({ agent: 'marvis', name: 'Marvis' });

    const sent = await (await post('/api/message', { agent: 'deepseek', text: '@marvis 桌面侧请确认' })).json();
    assert.equal(sent.wakes[0].channel, 'queued');
    assert.match(sent.warnings.join(' '), /已入队/);

    const state = await (await fetch(`${base}/api/state?limit=10`)).json();
    assert.equal(state.wakeQueue.marvis, 1, '侧栏应显示待唤醒 1');
    assert.equal(state.messages[sent.message.seq - 1].wake[0].channel, 'queued');

    const inbox = await (await fetch(`${base}/api/inbox?agent=marvis&wait=1`)).json();
    assert.equal(inbox.source, 'queued');
    assert.equal(inbox.wake.messageId, sent.message.id);

    const after = await (await fetch(`${base}/api/state?limit=10`)).json();
    assert.deepEqual(after.wakeQueue, {}, '取走后队列应清空');
  });
});

test('唤醒：成员自报回调地址时，点名立刻 POST 过去', async () => {
  const received = [];
  const receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const callbackUrl = `http://127.0.0.1:${receiver.address().port}/mention`;

  try {
    await withBoard(async ({ join, post }) => {
      await join({ agent: 'deepseek', name: 'DeepSeek' });
      const bot = await (
        await join({ agent: 'wakebot', name: 'Wake Bot', callback: callbackUrl })
      ).json();
      assert.equal(bot.wake.url, callbackUrl);

      const sent = await (await post('/api/message', { agent: 'deepseek', text: '@wakebot 请立刻处理' })).json();
      assert.equal(sent.wakes[0].channel, 'callback');
      assert.equal(sent.wakes[0].ok, true);

      for (let i = 0; i < 40 && !received.length; i++) await new Promise((r) => setTimeout(r, 25));
      assert.equal(received.length, 1);
      assert.equal(received[0].messageId, sent.message.id);
      assert.equal(received[0].agent, 'wakebot');
      assert.equal(received[0].from, 'deepseek');
    });
  } finally {
    await new Promise((resolve) => receiver.close(resolve));
  }
});

test('唤醒：本机唤醒命令不接受接入方自报', async () => {
  await withBoard(async ({ join, registry }) => {
    await join({ agent: 'sneaky', name: 'Sneaky', wakeCommand: 'cmd /c echo pwned' });
    const agent = registry.get('sneaky');
    assert.equal(agent.wakeCommand, '', '接入方不能在 /api/join 里配置唤醒命令');
    assert.equal(agent.wake, null);
  });
});

test('唤醒：长轮询也会刷新在线状态', async () => {
  await withBoard(async ({ base, join, state }) => {
    await join({ agent: 'codex', name: 'Codex' });
    const inbox = await (await fetch(`${base}/api/inbox?agent=codex&wait=1`)).json();
    assert.equal(inbox.wake, null);
    assert.equal(inbox.source, 'timeout');
    const payload = await state();
    const member = payload.agents.find((a) => a.id === 'codex');
    assert.equal(member.state, 'online');
    assert.equal(member.note, '监听点名中');
  });
});

test('唤醒：未登记成员不能长轮询', async () => {
  await withBoard(async ({ base }) => {
    const response = await fetch(`${base}/api/inbox?agent=ghost&wait=1`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, 'UNKNOWN_AGENT');
  });
});

/* ── 接入验收 ───────────────────────────────────────────── */

test('接入验收：心跳 / 唤醒通道 / 点名闭环 三项逐项点亮', async () => {
  await withBoard(async ({ base, join, post, state }) => {
    // 只登记 → 只有心跳这一项
    await join({ agent: 'codex', name: 'Codex', title: '项目主 Agent' });
    let payload = await state();
    let acc = payload.agents.find((a) => a.id === 'codex').acceptance;
    assert.equal(acc.checks.heartbeat, true, '登记即心跳');
    assert.equal(acc.checks.channel, false, '还没挂过长轮询');
    assert.equal(acc.checks.loop, false, '还没回过点名');
    assert.equal(acc.passed, 1);
    assert.equal(acc.status, 'partial');

    // 挂一次带等待的长轮询 → 唤醒通道点亮
    await fetch(`${base}/api/inbox?agent=codex&wait=1`);
    payload = await state();
    acc = payload.agents.find((a) => a.id === 'codex').acceptance;
    assert.equal(acc.checks.channel, true);
    assert.equal(acc.checks.loop, false);
    assert.equal(acc.passed, 2);

    // 被 @ 之后回一条带 replyTo 的实质内容 → 闭环点亮
    await join({ agent: 'deepseek', name: 'DeepSeek' });
    const asked = await (await post('/api/message', { agent: 'deepseek', text: '@codex 请确认。' })).json();
    await post('/api/message', { agent: 'codex', kind: 'reply', text: '结论：已确认。', replyTo: asked.message.id });

    payload = await state();
    acc = payload.agents.find((a) => a.id === 'codex').acceptance;
    assert.equal(acc.checks.loop, true);
    assert.equal(acc.status, 'verified');
    assert.equal(acc.replies.count, 1);
    assert.equal(payload.acceptance.verified, 1);
    assert.equal(payload.acceptance.total, 2, 'deepseek 只登记过，未通过验收');
  });
});

test('接入验收：处理中通知（notice）不算点名闭环', async () => {
  await withBoard(async ({ base, join, post, state }) => {
    await join({ agent: 'codex', name: 'Codex' });
    await fetch(`${base}/api/inbox?agent=codex&wait=1`);
    await join({ agent: 'deepseek', name: 'DeepSeek' });
    const asked = await (await post('/api/message', { agent: 'deepseek', text: '@codex 请处理。' })).json();
    await post('/api/message', { agent: 'codex', kind: 'notice', text: '正在处理…', replyTo: asked.message.id });

    const payload = await state();
    const acc = payload.agents.find((a) => a.id === 'codex').acceptance;
    assert.equal(acc.checks.loop, false, '只回"处理中"不算闭环');
    assert.equal(payload.acceptance.verified, 0);
  });
});

/* ── 静态资源与存储 ─────────────────────────────────────── */

test('黑板页面与静态资源可访问，越权路径被挡', async () => {
  await withBoard(async ({ base }) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /接入新成员/);
    assert.equal((await fetch(`${base}/board.css`)).status, 200);
    assert.equal((await fetch(`${base}/board.js`)).status, 200);
    const escaped = await fetch(`${base}/../server/index.js`);
    assert.ok(escaped.status === 403 || escaped.status === 404);
  });
});

test('存储：序号只增不改', async () => {
  await withBoard(async ({ dataDir, store }) => {
    const agent = { id: 'local', name: '本地', title: '本机操作员' };
    store.append({ agent, text: '一', mentions: [], flags: [] });
    store.append({ agent, text: '二', mentions: [], flags: [] });
    assert.deepEqual(store.list({ limit: 10 }).map((msg) => msg.seq), [1, 2]);
    assert.equal(fs.readFileSync(path.join(dataDir, 'messages.jsonl'), 'utf8').trim().split('\n').length, 2);
  });
});
