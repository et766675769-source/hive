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
import { fileURLToPath } from 'node:url';

import { createBoardServer } from '../server/index.js';
import { Registry } from '../server/registry.js';
import { isAcknowledgementOnly, parseMentions, localIso, stripBom } from '../server/protocol.js';

const dataRoot = process.env.MB_TEST_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'message-board-test-'));
fs.mkdirSync(dataRoot, { recursive: true });
// 测试里的哨兵不要把日志写进真实黑板的 data/logs：否则临时成员会出现在线上 sentinel.log 里，
// 排查线上问题时会被带偏（实测踩过一次）。
process.env.MB_SENTINEL_LOG_DIR = path.join(dataRoot, 'logs');

// 按时间判定的断言要"等到"而不是"睡固定时长"：睡 1.3 秒去验 1 秒截止曾经偶发失败
// （服务端那一刻的 updatedAt 差几十毫秒就会判成还差一点）。
async function waitFor(check, { timeoutMs = 5000, stepMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await check();
    if (last) return last;
    if (Date.now() > deadline) throw new Error(`等待超时（${timeoutMs}ms）：条件始终不成立`);
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

async function withBoard(run, overrides = {}) {  const dataDir = fs.mkdtempSync(path.join(dataRoot, 'board-'));
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

/* ── 引擎解耦（核心不认识厂商）──────────────────────────── */

test('引擎：核心自述可用引擎，且不依赖其中任何一个', async () => {
  await withBoard(async ({ base }) => {
    const body = await (await fetch(`${base}/api/engines`)).json();
    assert.equal(body.ok, true);
    const ids = body.engines.map((engine) => engine.id);
    for (const expected of ['rule-based', 'command', 'openai-compatible', 'human']) {
      assert.ok(ids.includes(expected), `缺少引擎 ${expected}`);
    }
    // 每个引擎都要能被解释清楚：核心只认识接口，不认识厂商
    for (const engine of body.engines) {
      assert.equal(typeof engine.label, 'string');
      assert.equal(typeof engine.summary, 'string');
      assert.ok(['local', 'cli', 'http', 'human'].includes(engine.kind), `未知类别 ${engine.kind}`);
    }
    assert.match(body.note, /不依赖任何引擎/);
  });
});

test('引擎：引擎注册表本身可解析、可运行、可外挂', async () => {
  const { listEngines, resolveEngine, register, runEngine } = await import('../engines/registry.mjs');
  assert.ok(listEngines().length >= 4);

  // 别名解析：历史叫法 deepseek-api 仍然指向 OpenAI 兼容那一路
  assert.equal(resolveEngine('deepseek-api').meta.id, 'openai-compatible');
  assert.equal(resolveEngine('codex').meta.id, 'codex-cli');
  assert.throws(() => resolveEngine('不存在的引擎'), /未知引擎/);

  // human 引擎必须在没有模型的情况下也"可用"，只是不自动回复
  await assert.rejects(runEngine('human', '随便', {}), (error) => error.code === 'MANUAL');

  // rule-based 不需要任何外部依赖，纯本地即可产出合规回复
  const reply = await runEngine('rule-based', '有人点名 #42 请回复', {});
  assert.match(reply.text, /结论：/);
  assert.match(reply.text, /#42/);

  // 外挂引擎：核心代码零改动即可接入第三方实现
  register({
    meta: { id: 'in-test', label: '测试引擎', kind: 'local', summary: '仅用于测试' },
    async run(prompt) {
      return { text: `来自测试引擎：${prompt}` };
    },
  });
  const external = await runEngine('in-test', '你好', {});
  assert.equal(external.text, '来自测试引擎：你好');
});

test('引擎：接入时声明引擎，名册如实显示；不声明则不冒充', async () => {
  await withBoard(async ({ join, base }) => {
    await join({ agent: 'plain', name: '纯命令成员', engine: 'command' });
    await join({ agent: 'probe', name: '链路自检', engine: 'rule-based' });
    await join({ agent: 'mystery', name: '未声明成员' });

    const body = await (await fetch(`${base}/api/config`)).json();
    const byId = Object.fromEntries(body.members.map((member) => [member.id, member]));
    assert.equal(byId.plain.engine, 'command');
    assert.equal(byId.probe.engine, 'rule-based');
    assert.equal(byId.mystery.engine, '', '没声明就留空，核心不替成员猜');

    // 接入提示词要告诉新成员"引擎是什么、有哪些可选"，并明确"没有 Codex CLI 也能通信"
    const prompt = await (await fetch(`${base}/api/prompt?agent=newbie`)).text();
    assert.match(prompt, /engine/);
    assert.match(prompt, /openai-compatible/);
    assert.match(prompt, /没有 Codex CLI 也能通信/);
  });
});

/* ── 哨兵：巡检「谁在线却沉默」────────────────────────────── */

test('哨兵：判定「在线但沉默」要有证据（点名超时 + 没有正在进行的生成）', async () => {
  const { classifyBoard, planTakeovers } = await import('../tools/sentinel.mjs');
  const nowMs = Date.parse('2026-09-12T00:00:00+08:00');
  const member = {
    id: 'workbuddy',
    state: 'online',
    declared: 'online',
    engine: '',
    respondMode: 'autonomous',
    openDeliveries: 0,
    deliveryCounts: { expired: 3, replied: 1 },
    acceptance: { checks: { heartbeat: true, channel: true, loop: false }, loopWindowHours: 24 },
  };
  const pending = [
    { agent: 'workbuddy', seq: 114, at: '2026-09-11T22:20:48+08:00' },
    { agent: 'workbuddy', seq: 116, at: '2026-09-11T22:31:00+08:00' },
  ];

  const { findings, totals } = classifyBoard({ agents: [member], pending }, { nowMs, silentMinutes: 15 });
  const codes = findings.map((finding) => finding.code).sort();
  assert.deepEqual(codes, ['DELIVERIES_EXPIRED', 'LISTENING_BUT_NEVER_REPLIED', 'NO_ENGINE', 'SILENT_WITH_PENDING']);
  const silent = findings.find((finding) => finding.code === 'SILENT_WITH_PENDING');
  assert.equal(silent.severity, 'alert');
  assert.equal(silent.ageMinutes, 99, '最老的那条点名已等 99 分钟');
  assert.deepEqual(silent.seqs, [114, 116]);
  assert.equal(totals.alert, 1);

  // 关键分寸：正在生成（自报 busy）不该判成沉默，否则会打断真在干活的人
  const busy = classifyBoard({ agents: [{ ...member, declared: 'busy' }], pending }, { nowMs, silentMinutes: 15 });
  assert.equal(busy.findings.some((finding) => finding.code === 'SILENT_WITH_PENDING'), false);
  // 反过来：有未完成投递但没人自报在处理 = 恰恰是"没人来取"，必须报出来
  const queued = classifyBoard(
    { agents: [{ ...member, openDeliveries: 2, state: 'online' }], pending },
    { nowMs, silentMinutes: 15 },
  );
  const queuedFinding = queued.findings.find((finding) => finding.code === 'SILENT_WITH_PENDING');
  assert.ok(queuedFinding, '排队中没人取件也必须判成沉默');
  assert.match(queuedFinding.detail, /没有人来取/);

  // 阈值以内不算沉默
  const fresh = classifyBoard(
    { agents: [member], pending: [{ agent: 'workbuddy', seq: 190, at: '2026-09-11T23:55:00+08:00' }] },
    { nowMs, silentMinutes: 15 },
  );
  assert.equal(fresh.findings.some((finding) => finding.code === 'SILENT_WITH_PENDING'), false);

  // manual 成员等人是它的声明形态，不是故障
  const manual = classifyBoard(
    { agents: [{ ...member, respondMode: 'manual', deliveryCounts: { expired: 0 } }], pending },
    { nowMs, silentMinutes: 15 },
  );
  assert.equal(manual.findings.some((finding) => finding.code === 'SILENT_WITH_PENDING'), false);
  assert.ok(manual.findings.some((finding) => finding.code === 'MANUAL_WAITING'));

  // 接管计划：有托管配置才谈接管，且受冷却约束
  const members = [{ id: 'workbuddy', start: ['node', 'x.js'] }];
  const plan = planTakeovers(findings, members, { status: {}, nowMs, cooldownMinutes: 60 });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].ok, true);
  const cooling = planTakeovers(findings, members, {
    status: { takeovers: { workbuddy: new Date(nowMs - 5 * 60000).toISOString() } },
    nowMs,
    cooldownMinutes: 60,
  });
  assert.equal(cooling[0].ok, false);
  assert.match(cooling[0].reason, /冷却/);
  assert.equal(planTakeovers(findings, [], { nowMs }).length, 0, '没有托管配置就不接管');
});

test('哨兵：一轮巡检把契约违约写回黑板，且不刷屏、不关掉别人的点名', async () => {
  const { runRound } = await import('../tools/sentinel.mjs');
  const statusFile = path.join(dataRoot, `sentinel-${Date.now()}.json`);
  await withBoard(
    async ({ join, base, post, state }) => {
      // 一个"接了活但没人来取"的成员：登记了引擎，长轮询没挂，点名只能排队
      await join({ agent: 'silent', name: '沉默成员', engine: 'rule-based' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await post('/api/message', { agent: 'local', kind: 'message', topic: null, text: '@silent 请回答一个具体问题' });
      // ack 窗口设成 1 秒：契约判据用服务端真实时间，等到违约真的成立再跑巡检
      await waitFor(async () => {
        const body = await state('?limit=10');
        const found = body.agents.find((agent) => agent.id === 'silent');
        return found && found.contract && found.contract.severity === 'alert';
      });

      const roundOptions = {
        board: base,
        statusFile,
        silentMinutes: 1,
        cooldownMinutes: 60,
        takeover: false, // 测试里不真的拉进程
      };
      const first = await runRound(roundOptions);
      const breach = first.findings.find((finding) => finding.code === 'NOT_FETCHED');
      assert.ok(breach, `应判出契约违约（实际：${first.findings.map((f) => f.code).join(', ')}）`);
      assert.equal(breach.member, 'silent');
      assert.equal(breach.severity, 'alert');
      assert.ok(
        first.acted.some((item) => item.code === 'NOT_FETCHED' && item.seq),
        'alert 级结论会发言，并且真的落到黑板上',
      );

      const body = await state('?limit=50');
      const notices = body.messages.filter((message) => message.agent === 'sentinel');
      assert.equal(notices.length, first.acted.length, '每条结论一条 notice，不打折也不重复');
      assert.equal(notices[0].kind, 'notice');
      assert.equal(notices[0].agentName, '哨兵', '发言者姓名可读');
      assert.equal(notices[0].client.sentinel, true, '发言带哨兵标记，便于过滤');

      // 关键分寸：哨兵的 notice 不能把别人的点名"关掉"
      assert.ok(body.pending.some((item) => item.agent === 'silent'), '点名仍是待回应');

      // 同理：契约违约只报一次，不刷屏
      const second = await runRound({ ...roundOptions, status: first.status });
      assert.equal(second.acted.length, 0, '状态没变化就不该再刷一条');
      const after = await state('?limit=50');
      assert.equal(after.messages.filter((message) => message.agent === 'sentinel').length, notices.length);

      fs.rmSync(statusFile, { force: true });
    },
    { delivery: { ackTimeoutSeconds: 1 } },
  );
});

test('哨兵：身份是隐藏的 operator（不占名册、不能被 @，但发言看得见名字）', async () => {
  await withBoard(async ({ base, post, state }) => {
    const body = await state('?limit=10');
    // 名册仍然"接入即登记"：哨兵是运维设施，不该占用成员位
    assert.equal(body.agents.some((agent) => agent.id === 'sentinel'), false, '哨兵不出现在名册里');

    const posted = await (
      await post('/api/message', {
        agent: 'sentinel',
        kind: 'notice',
        topic: '哨兵巡检',
        text: '【哨兵】巡检示例：本条用来确认它发言时姓名可读。',
      })
    ).json();
    assert.equal(posted.ok, true);
    const after = await state('?limit=10');
    const message = after.messages.find((item) => item.seq === posted.message.seq);
    assert.equal(message.agent, 'sentinel');
    assert.equal(message.agentName, '哨兵', '预置身份提供姓名，面板上不会只剩一个裸 id');

    // 它是 operator：不会出现在 @ 点名候选里（前端按 kind 过滤），所以点名它不会制造假待回应
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.equal(config.members.some((agent) => agent.id === 'sentinel'), false);
  });
});

test('哨兵：托管清单带 BOM 也能读，读不出来必须说出来（不能静默地没有配置）', async () => {
  const { readManagedMembers } = await import('../tools/sentinel.mjs');
  const dir = fs.mkdtempSync(path.join(dataRoot, 'sentinel-members-'));
  const good = {
    members: [{ id: 'a', start: ['node', 'x.js'] }, { id: 'b', start: ['node', 'y.js'] }, { id: 'off', enabled: false, start: ['node', 'z.js'] }],
  };
  const body = JSON.stringify(good, null, 2);

  const plain = path.join(dir, 'plain.json');
  fs.writeFileSync(plain, body, 'utf8');
  assert.deepEqual(readManagedMembers(plain, () => {}).map((item) => item.id), ['a', 'b']);

  // Windows 上记事本与 PowerShell 的 Out-File 都会写 BOM：读不出来就等于"没有托管配置"，
  // 而哨兵此前的表现是静默跳过接管——最难查的那种故障。
  const bom = path.join(dir, 'bom.json');
  fs.writeFileSync(bom, `\uFEFF${body}`, 'utf8');
  assert.deepEqual(readManagedMembers(bom, () => {}).map((item) => item.id), ['a', 'b'], '带 BOM 的清单必须照样能读');

  const warnings = [];
  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, '{ "members": [ ', 'utf8');
  assert.deepEqual(readManagedMembers(broken, (message) => warnings.push(message)), []);
  assert.match(warnings.join('\n'), /不是合法 JSON/, '解析失败要明说，不能假装没有托管配置');

  const empty = path.join(dir, 'empty.json');
  fs.writeFileSync(empty, '{ "members": [] }', 'utf8');
  warnings.length = 0;
  assert.deepEqual(readManagedMembers(empty, (message) => warnings.push(message)), []);
  assert.match(warnings.join('\n'), /空/);

  warnings.length = 0;
  assert.deepEqual(readManagedMembers(path.join(dir, 'missing.json'), (message) => warnings.push(message)), []);
  assert.match(warnings.join('\n'), /不存在/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('归属锁：同一成员的托管通道只有一个正主，卡死才允许接管', async () => {
  const { evaluateLock, acquireLock, readLock } = await import('../tools/channel-lock.mjs');
  const nowMs = Date.parse('2026-09-12T00:00:00+08:00');
  const alive = () => true;
  const dead = () => false;

  assert.equal(evaluateLock(null, { nowMs }).state, 'free');
  assert.equal(evaluateLock({ pid: 1 }, { nowMs, isAlive: dead }).state, 'free', '进程没了就该让位');

  const fresh = { pid: 4242, startedAt: new Date(nowMs - 60000).toISOString(), beatAt: new Date(nowMs - 30000).toISOString() };
  assert.equal(evaluateLock(fresh, { nowMs, isAlive: alive }).state, 'held');
  assert.match(evaluateLock(fresh, { nowMs, isAlive: alive }).reason, /4242/);

  // 进程还在、但很久没心跳：卡死，必须允许接管，否则这个成员会永久沉默
  const stale = { pid: 4242, startedAt: new Date(nowMs - 3600000).toISOString(), beatAt: new Date(nowMs - 30 * 60000).toISOString() };
  assert.equal(evaluateLock(stale, { nowMs, isAlive: alive }).state, 'stale');
  assert.match(evaluateLock(stale, { nowMs, isAlive: alive }).reason, /没有心跳/);

  // 真实取锁：同一目录第二次取会看到"已被持有"
  const dir = fs.mkdtempSync(path.join(dataRoot, 'lock-'));
  const first = acquireLock(dir, { agent: 'demo' });
  assert.equal(first.held, false);
  assert.equal(readLock(dir).pid, process.pid);
  const second = acquireLock(dir, { agent: 'demo' });
  assert.equal(second.held, true, '第二个进程必须让位');
  assert.match(second.reason, new RegExp(String(process.pid)));
  first.release();
  assert.equal(readLock(dir), null, '正常退出要释放锁');
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ── 契约：点名 → 回执 → 结果 ─────────────────────────────── */

test('契约：四种进行中状态各有判据，违约只有三种', async () => {
  const { contractOf, CONTRACT } = await import('../server/contract.js');
  const nowMs = Date.parse('2026-09-12T00:10:00+08:00');
  const view = (state, secondsAgo, extra = {}) => ({
    seq: 42,
    state,
    updatedAt: new Date(nowMs - secondsAgo * 1000).toISOString(),
    ackDeadlineAt: nowMs + 1000,
    ...extra,
  });
  const options = { nowMs, ackTimeoutSeconds: 45, deliveryBudgetSeconds: 600 };

  assert.equal(contractOf([], options).state, CONTRACT.IDLE);

  // 排队中，还在 ack 窗口内 → 正常
  assert.equal(contractOf([view('queued', 10)], options).state, CONTRACT.QUEUED);
  // 排队超时 → 没人取件（这是最该报警的一种：唤醒通道挂着也没人来拿）
  assert.equal(contractOf([view('queued', 90)], options).state, CONTRACT.NOT_FETCHED);

  // 已送达、回执未过期 → 正常等待
  assert.equal(
    contractOf([view('delivered', 10, { ackDeadlineAt: nowMs + 30000 })], options).state,
    CONTRACT.WAITING_ACK,
  );
  // 已送达、回执过期 → 没开始
  const noAck = contractOf([view('delivered', 90, { ackDeadlineAt: nowMs - 45000 })], options);
  assert.equal(noAck.state, CONTRACT.NO_ACK);
  assert.match(noAck.detail, /没有.*回执/);

  // 已回执、还在预算内 → 正在处理
  assert.equal(contractOf([view('working', 120)], options).state, CONTRACT.WORKING);
  // 已回执、超出交付预算 → 开始了没交付
  assert.equal(contractOf([view('working', 700)], options).state, CONTRACT.OVERDUE);

  // 作废（重试用尽）是最硬的违约：账本已经不指望它了，点名却从来没被答复。
  // 这条如果不算违约，一个"回执一句就消失"的成员会在重试用尽后显示成"无待办"（实测踩过 #155）。
  const expired = contractOf([view('expired', 30, { endedBy: null })], options);
  assert.equal(expired.state, CONTRACT.UNFULFILLED);
  assert.equal(expired.severity, 'alert');
  assert.match(expired.detail, /作废/);
  // 人类主动叫停不算成员失职：这类由调用方先排除，contractOf 拿到的是干净的输入
  assert.deepEqual(
    contractOf([view('queued', 10)], options).state,
    CONTRACT.QUEUED,
    '被叫停的投递不该由契约判定成违约（在上游过滤）',
  );

  // 多条里挑最"卡"的那条：违约优先于正常
  const mixed = contractOf([view('working', 30), view('queued', 200)], options);
  assert.equal(mixed.state, CONTRACT.NOT_FETCHED);
  assert.equal(mixed.open, 2);

  // 等人不是违约
  const manual = contractOf([view('queued', 600)], { ...options, respondMode: 'manual' });
  assert.equal(manual.state, CONTRACT.MANUAL);
  assert.equal(manual.severity, 'info');
});

test('契约：服务端把「卡在哪一步」写进成员卡与待回应列表', async () => {
  await withBoard(
    async ({ join, post, state }) => {
      await join({ agent: 'slow', name: '慢成员', engine: 'rule-based' });
      await post('/api/message', { agent: 'local', kind: 'message', text: '@slow 请回答' });

      // 等到契约真的判成"没人取件"再断言（ack 窗口 1 秒，睡眠固定时长会偶发失败）
      const member = await waitFor(async () => {
        const body = await state('?limit=10');
        const found = body.agents.find((agent) => agent.id === 'slow');
        return found && found.contract && found.contract.state === 'not-fetched' ? found : null;
      });
      const body = await state('?limit=10');
      assert.ok(member.contract, '成员卡必须带契约状态（面板主信息就是它）');
      assert.equal(member.contract.severity, 'alert');
      assert.match(member.contract.label, /没人取件/);
      assert.match(member.contract.detail, /#\d+/);

      // 待回应列表也要带投递事实，界面与哨兵才知道卡在哪一步
      const pending = body.pending.find((item) => item.agent === 'slow');
      assert.ok(pending.delivery, '待回应项要带 delivery 视图');
      assert.equal(pending.delivery.state, 'queued');
      assert.ok(Number(pending.delivery.updatedAt) > 0, '投递视图要带状态变更时间（判据的锚点）');
      assert.ok(member.contract.waitingSeconds >= 1, '契约要给出"等了多久"');
    },
    { delivery: { ackTimeoutSeconds: 1 } },
  );
});

test('契约：作废的投递仍算违约，人类主动叫停不算', async () => {
  const { classifyBoard } = await import('../tools/sentinel.mjs');
  const { contractOf, CONTRACT } = await import('../server/contract.js');
  const nowMs = Date.now();

  // 一个"回执一句然后消失"的成员：投递被判作废（重试用尽）
  const member = {
    id: 'ghost',
    state: 'online',
    declared: 'online',
    respondMode: 'autonomous',
    engine: 'codex-cli',
    openDeliveries: 0,
    deliveryCounts: { expired: 1, replied: 0 },
    contract: contractOf(
      [{ seq: 155, state: 'expired', updatedAt: nowMs - 60000, endedBy: null }],
      { nowMs, ackTimeoutSeconds: 45, deliveryBudgetSeconds: 600 },
    ),
    acceptance: { checks: { heartbeat: true, channel: true, loop: false }, loopWindowHours: 24 },
  };
  const pending = [{ agent: 'ghost', seq: 155, at: new Date(nowMs - 900000).toISOString() }];

  const { findings } = classifyBoard({ agents: [member], pending }, { nowMs, silentMinutes: 15 });
  const breach = findings.find((finding) => finding.code === 'UNFULFILLED');
  assert.ok(breach, `作废必须报出来（实际：${findings.map((f) => f.code).join(', ')}）`);
  assert.equal(breach.severity, 'alert', '作废是 alert：它足够硬，应该能触发接管');
  assert.match(breach.title, /作废未回应/);

  // 人类主动叫停的那一条不该进契约（服务端在上游按 endedBy 过滤），也就不会有 UNFULFILLED
  const interrupted = contractOf(
    [{ seq: 156, state: 'replied', updatedAt: nowMs - 1000 }],
    { nowMs, ackTimeoutSeconds: 45, deliveryBudgetSeconds: 600 },
  );
  assert.equal(interrupted.state, CONTRACT.IDLE);
});

test('接入：照抄一条命令的"笨成员"能在面板上出现、先回执再交付', async () => {
  // 这是针对"下一个接入的 AI 可能不那么聪明"的验收：
  // 它只做一件事——在仓库目录里跑 tools/mb.js serve，别的什么都不懂。
  // 曾经这条路上有个真 bug（member-loop 的提示词引用了 main() 里的局部 IDENTITY），
  // 结果它被点名后回的是"我无法完成这条指名：IDENTITY is not defined"。
  const { spawn } = await import('node:child_process');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  await withBoard(async ({ base, post, state }) => {
    // 顺序很关键：先让它接上，再点名。
    // 黑板只认可**已登记**成员的 @（parseMentions 只认名册），所以"还没登记的成员被 @ 到"
    // 这件事在协议上根本不存在——先登记、再被点名，这就是提示词把登记放在第 1 步的原因。
    const child = spawn(
      process.execPath,
      ['tools/mb.js', 'serve', 'rookie', '--name', '新人', '--board', base],
      { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    let spawnError = null;
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      spawnError = `${error.code || ''} ${error.message}`;
    });

    try {
      // ① 它自己接上了：出现在名册里，并且挂上了唤醒通道
      const online = await waitFor(async () => {
        const body = await state('?limit=10');
        const found = body.agents.find((agent) => agent.id === 'rookie');
        return found && found.acceptance.checks.channel ? found : null;
      }, { timeoutMs: 20000 }).catch(() => null);
      assert.ok(
        online,
        `它没接上（pid=${child.pid} exitCode=${child.exitCode} spawnError=${spawnError}）：\n${output.slice(0, 500)}`,
      );

      // ② 现在点名：被 @ 后它必须"先回执、再交付"，两步都落到黑板上
      const mention = await (
        await post('/api/message', { agent: 'local', kind: 'message', topic: null, text: '@rookie 请确认你能实时收到点名并回话。' })
      ).json();
      assert.deepEqual(mention.message.mentions, ['rookie'], '点名必须被识别（它已登记）');

      const replied = await waitFor(async () => {
        const body = await state('?limit=50');
        return body.messages.find((message) => message.agent === 'rookie' && message.kind === 'reply') || null;
      }, { timeoutMs: 25000 }).catch((error) => {
        throw new Error(
          `${error.message}\npid=${child.pid} exitCode=${child.exitCode} spawnError=${spawnError}\n子进程输出：\n${output.slice(0, 800)}`,
        );
      });

      assert.equal(replied.replyTo, mention.message.id, '回复必须挂在被点名的那条留言上');
      assert.ok(!/is not defined/.test(replied.text), `回复不能是内部报错：${replied.text.slice(0, 120)}`);
      assert.match(replied.text, /结论/, '默认引擎也要给出合规的"结论/依据/下一步"');

      const body = await state('?limit=50');
      const ack = body.messages.find(
        (message) => message.agent === 'rookie' && message.kind === 'notice' && message.replyTo === mention.message.id,
      );
      assert.ok(ack, '要先回一条"已收到、开始处理"的回执（契约的第一半）');
      // 比序号，不要比对象：replied 来自前一次请求的数组，用 indexOf 比对象恒为 -1
      assert.ok(ack.seq < replied.seq, `回执要先于结果（回执 #${ack.seq}，结果 #${replied.seq}）`);

      const member = body.agents.find((agent) => agent.id === 'rookie');
      assert.equal(member.acceptance.checks.loop, true, '回过实质内容后，点名闭环应当点亮');
      assert.equal(member.contract.state, 'idle', '交付之后契约回到"无待办"');
      assert.equal(body.pending.some((item) => item.agent === 'rookie'), false, '待回应应当清空');
    } finally {
      child.kill();
    }
    assert.ok(output.includes('rookie'), '它自己也要打印出被接上的事实');
  });
});

test('接入：登记之前发出的 @ 不算点名（顺序错了，别人永远等不到你）', async () => {
  await withBoard(async ({ post, state }) => {
    const early = await (
      await post('/api/message', { agent: 'local', kind: 'message', text: '@latecomer 你能收到吗？' })
    ).json();
    assert.deepEqual(early.message.mentions, [], '名册里没有 latecomer，这条 @ 不会被当作点名');
    assert.equal(early.wakes.length, 0, '也不会产生任何唤醒');

    // 登记之后再点名才算数
    await post('/api/join', { agent: 'latecomer', name: '迟到者' });
    const later = await (
      await post('/api/message', { agent: 'local', kind: 'message', text: '@latecomer 现在呢？' })
    ).json();
    assert.deepEqual(later.message.mentions, ['latecomer']);

    const body = await state('?limit=10');
    const pending = body.pending.filter((item) => item.agent === 'latecomer');
    assert.equal(pending.length, 1, '只有登记之后那一条才算待回应');
    assert.equal(pending[0].seq, later.message.seq);
  });
});

test('接入自检：doctor 逐条说清差哪一项，并给出下一步命令', async () => {
  const { spawn } = await import('node:child_process');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const run = (args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (chunk) => {
        out += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk) => {
        out += chunk.toString('utf8');
      });
      child.on('exit', (code) => resolve({ code, out }));
    });

  await withBoard(async ({ base }) => {
    // 还什么都没做：doctor 必须说"你还没登记"，并给出可以直接照抄的命令
    const before = await run(['tools/mb.js', 'doctor', 'rookie', '--board', base]);
    assert.equal(before.code, 1, '没接上时退出码非 0（脚本里能直接用来判断）');
    assert.match(before.out, /还没登记/);
    assert.match(before.out, /mb\.js join rookie/);
    assert.match(before.out, /mb\.js serve rookie/);
  });
});

test('契约：人类可以「重新派发」一条违约的点名，让它重新走一遍投递', async () => {
  await withBoard(
    async ({ base, join, post, state }) => {
      await join({ agent: 'ghost', name: '幽灵', engine: 'rule-based' });
      const mention = await (
        await post('/api/message', { agent: 'local', kind: 'message', text: '@ghost 请回答' })
      ).json();

      // 没挂通道 → 排队 → 过 ack 窗口 → 契约违约（没人取件），并带上 messageId 供界面按钮定位
      await waitFor(async () => {
        const body = await state('?limit=10');
        const member = body.agents.find((agent) => agent.id === 'ghost');
        return member && member.contract && member.contract.severity === 'alert' ? member : null;
      });
      const before = await state('?limit=10');
      const member = before.agents.find((agent) => agent.id === 'ghost');
      assert.equal(member.contract.state, 'not-fetched');
      assert.equal(member.contract.messageId, mention.message.id, '契约要给出 messageId，界面才能"这一条"重新派发');

      const requeued = await (
        await fetch(`${base}/api/requeue`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent: 'ghost', messageId: mention.message.id }),
        })
      ).json();
      assert.equal(requeued.ok, true);
      assert.match(requeued.note, /重新入队/);

      // 重新派发后，这一条的投递回到 queued（窗口重新计），不再是"作废"
      const record = requeued.delivery[0];
      assert.equal(record.state, 'queued');
      assert.match(record.note, /人工重新派发/);
      assert.equal(record.ackDeadlineAt, null, '回执截止要清零，重新给完整窗口');

      // 缺参数要明确报错
      const bad = await (
        await fetch(`${base}/api/requeue`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: 'ghost' }) })
      ).json();
      assert.equal(bad.ok, false);
      assert.equal(bad.code, 'MISSING_FIELD');
    },
    { delivery: { ackTimeoutSeconds: 1 } },
  );
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

/* ── 投递生命周期 / 幂等 / 打断 ─────────────────────────── */

test('投递：queued → delivered → working → replied 逐级推进', async () => {
  await withBoard(async ({ base, join, post, state }) => {
    await join({ agent: 'deepseek', name: 'DeepSeek' });
    await join({ agent: 'codex', name: 'Codex' });

    // 先让 codex 挂上长轮询，保证能即时送达
    const waiting = fetch(`${base}/api/inbox?agent=codex&wait=5`).then((r) => r.json());
    await new Promise((resolve) => setTimeout(resolve, 200));

    const asked = await (await post('/api/message', { agent: 'deepseek', text: '@codex 请处理。' })).json();
    assert.equal(asked.delivery.length, 1);
    assert.equal(asked.delivery[0].state, 'delivered');
    assert.equal(asked.delivery[0].attempts, 1);
    assert.ok(asked.delivery[0].deadlineAt, '送达后开始计租约');

    await post('/api/message', { agent: 'codex', kind: 'notice', text: '正在处理…', replyTo: asked.message.id });
    let payload = await state();
    let record = payload.messages.find((m) => m.id === asked.message.id).delivery[0];
    assert.equal(record.state, 'working');
    assert.equal(payload.deliverySummary.counts.working, 1);

    await post('/api/message', { agent: 'codex', kind: 'reply', text: '结论：已完成。', replyTo: asked.message.id });
    payload = await state();
    record = payload.messages.find((m) => m.id === asked.message.id).delivery[0];
    assert.equal(record.state, 'replied');
    assert.equal(record.deadlineAt, null, '终态不再计租约');
    assert.equal(payload.deliverySummary.counts.replied, 1);

    await waiting;
  });
});

test('投递：没有可用通道时停在 queued，并计入该成员的未完成投递', async () => {
  await withBoard(async ({ join, post, state }) => {
    await join({ agent: 'deepseek', name: 'DeepSeek' });
    await join({ agent: 'marvis', name: 'Marvis' });

    const asked = await (await post('/api/message', { agent: 'deepseek', text: '@marvis 请确认。' })).json();
    assert.equal(asked.delivery[0].state, 'queued');
    assert.equal(asked.delivery[0].deadlineAt, null);

    const payload = await state();
    assert.equal(payload.deliverySummary.counts.queued, 1);
    assert.equal(payload.agents.find((a) => a.id === 'marvis').openDeliveries, 1);
  });
});

test('投递：成员已掉线时，租约到期自动回收重投', async () => {
  await withBoard(
    async ({ base, join, post, state }) => {
      await join({ agent: 'deepseek', name: 'DeepSeek' });
      await join({ agent: 'marvis', name: 'Marvis' });

      const waiting = fetch(`${base}/api/inbox?agent=marvis&wait=3`).then((r) => r.json());
      await new Promise((resolve) => setTimeout(resolve, 200));
      const asked = await (await post('/api/message', { agent: 'deepseek', text: '@marvis 请确认。' })).json();
      assert.equal(asked.delivery[0].state, 'delivered');
      await waiting;

      // 心跳 TTL 1 秒：让它在下一次巡检前就变成 stale（= 没人接活）。
      // 等到"账本真的回收了"再断言，而不是睡一个固定时长——满载时固定睡眠会抖。
      const record = await waitFor(async () => {
        const payload = await state();
        const found = payload.messages.find((m) => m.id === asked.message.id).delivery[0];
        return found.state === 'queued' ? found : null;
      }, { timeoutMs: 20000 });
      assert.match(record.note, /回收重投/);
      assert.equal(record.attempts, 1, '重投前仍算 1 次送达记录');
    },
    {
      presence: { heartbeatTtlSeconds: 1, sweepSeconds: 1, staleMultiplier: 2 },
      delivery: { leaseSeconds: 1, maxAttempts: 2, sweepSeconds: 1 },
    },
  );
});

test('投递：成员仍在线时长任务只续租，不被误判超时重投', async () => {
  await withBoard(
    async ({ base, join, post, state }) => {
      await join({ agent: 'deepseek', name: 'DeepSeek' });
      await join({ agent: 'marvis', name: 'Marvis' });

      const waiting = fetch(`${base}/api/inbox?agent=marvis&wait=3`).then((r) => r.json());
      await new Promise((resolve) => setTimeout(resolve, 200));
      const asked = await (await post('/api/message', { agent: 'deepseek', text: '@marvis 长任务。' })).json();
      assert.equal(asked.delivery[0].state, 'delivered');
      await waiting;

      // 自报 busy + 具体条号：租约到期时应当续租，而不是把 Codex 的活重投一遍。
      // 租约给 3 秒（而不是 1 秒）：本用例要观察的是"持续续租"这个行为，
      // 不该因为机器满载时一次心跳晚了几百毫秒就判成超时。
      for (let i = 0; i < 6; i += 1) {
        const poll = fetch(`${base}/api/inbox?agent=marvis&wait=2`).then((r) => r.json());
        await new Promise((resolve) => setTimeout(resolve, 700));
        await post('/api/heartbeat', { agent: 'marvis', state: 'busy', note: `正在处理 #${asked.message.seq}` });
        await poll;
      }

      const payload = await state();
      const record = payload.messages.find((m) => m.id === asked.message.id).delivery[0];
      assert.ok(record.state === 'delivered' || record.state === 'working', `应保持已送达/处理中，实际 ${record.state}`);
      assert.match(record.note, /续租/);
      assert.equal(payload.deliverySummary.counts.expired, 0, '成员自报在处理的活不该被判超时');
    },
    // 上限放宽：本用例要观察的是"自报在跑 → 持续续租"，不测次数上限
    { delivery: { leaseSeconds: 3, maxAttempts: 2, sweepSeconds: 1, maxRenewals: 50 } },
  );
});

test('投递：只挂心跳但不自报在处理该条时，仍按租约超时回收', async () => {
  await withBoard(
    async ({ base, join, post, state }) => {
      await join({ agent: 'deepseek', name: 'DeepSeek' });
      await join({ agent: 'marvis', name: 'Marvis' });

      const waiting = fetch(`${base}/api/inbox?agent=marvis&wait=3`).then((r) => r.json());
      await new Promise((resolve) => setTimeout(resolve, 200));
      const asked = await (await post('/api/message', { agent: 'deepseek', text: '@marvis 长任务。' })).json();
      assert.equal(asked.delivery[0].state, 'delivered');
      await waiting; // 取走了这一条

      // 之后**只心跳、不再取件**，且从不自报"在处理这一条" → 说明活其实丢了
      for (let i = 0; i < 5; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 600));
        await post('/api/heartbeat', { agent: 'marvis', state: 'online', note: '空闲' });
      }

      const record = await waitFor(async () => {
        const payload = await state();
        const found = payload.messages.find((m) => m.id === asked.message.id).delivery[0];
        return found.state === 'queued' ? found : null;
      }, { timeoutMs: 20000 });
      assert.match(record.note, /回收|重投/);
    },
    { delivery: { leaseSeconds: 1, maxAttempts: 2, sweepSeconds: 1 } },
  );
});

test('幂等：同一 idempotencyKey 只落一条留言', async () => {
  await withBoard(async ({ join, post, state }) => {
    await join({ agent: 'deepseek', name: 'DeepSeek' });
    const body = { agent: 'deepseek', text: '只此一条。', idempotencyKey: 'reply-token-1' };
    const first = await (await post('/api/message', body)).json();
    const second = await (await post('/api/message', body)).json();
    assert.equal(first.duplicate, undefined);
    assert.equal(second.duplicate, true);
    assert.equal(second.message.id, first.message.id);
    const payload = await state();
    assert.equal(payload.messages.length, 1);
  });
});

test('打断：下发控制指令后成员能从 inbox 取到 control 信封', async () => {
  await withBoard(async ({ base, join }) => {
    await join({ agent: 'codex', name: 'Codex' });
    const response = await fetch(`${base}/api/interrupt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'codex', reason: '测试打断' }),
    });
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.queueDepth, 1);

    const inbox = await (await fetch(`${base}/api/inbox?agent=codex&wait=1`)).json();
    assert.equal(inbox.wake.type, 'control');
    assert.equal(inbox.wake.action, 'interrupt');
    assert.equal(inbox.wake.reason, '测试打断');
    assert.equal(inbox.wake.issuedBy, 'local');
  });
});

test('打断：未知成员被拒', async () => {
  await withBoard(async ({ base }) => {
    const response = await fetch(`${base}/api/interrupt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'ghost' }),
    });
    assert.equal(response.status, 404);
  });
});

test('打断：人类叫停后投递直接终结，且不会被租约自动重投', async () => {
  await withBoard(
    async ({ base, join, post, state }) => {
      await join({ agent: 'deepseek', name: 'DeepSeek' });
      await join({ agent: 'codex', name: 'Codex' });

      const waiting = fetch(`${base}/api/inbox?agent=codex&wait=5`).then((r) => r.json());
      await new Promise((resolve) => setTimeout(resolve, 200));
      const asked = await (await post('/api/message', { agent: 'deepseek', text: '@codex 长任务。' })).json();
      await post('/api/message', { agent: 'codex', kind: 'notice', text: '正在处理…', replyTo: asked.message.id });
      await waiting;

      // 通道回报"已被人类打断"
      await post('/api/message', {
        agent: 'codex',
        kind: 'notice',
        status: '阻塞',
        text: '本轮已被人类打断。',
        replyTo: asked.message.id,
        client: { interrupted: true },
      });

      let payload = await state();
      let record = payload.messages.find((m) => m.id === asked.message.id).delivery[0];
      assert.equal(record.state, 'expired', '被打断 = 终结');
      assert.match(record.note, /不再重投/);

      // 等过租约与巡检，确认没有被"回收重投"
      await new Promise((resolve) => setTimeout(resolve, 3500));
      payload = await state();
      record = payload.messages.find((m) => m.id === asked.message.id).delivery[0];
      assert.equal(record.state, 'expired');
      assert.deepEqual(payload.wakeQueue, {}, '不应把被打断的任务放回队列');
      const cnt = payload.agents.find((a) => a.id === 'codex').deliveryCounts;
      assert.equal(cnt.interrupted, 1, '被叫停要单独计');
      assert.equal(cnt.expired, 0, '被叫停不能算成超时未回');
    },
    { delivery: { leaseSeconds: 1, maxAttempts: 2, sweepSeconds: 1 } },
  );
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

/* ── 同步：增量补拉的分页语义 ───────────────────────────── */

test('同步：since 增量按"最早优先"返回，分页能完整补齐而不跳号', async () => {
  await withBoard(
    async ({ join, post, state }) => {
      await join({ agent: 'deepseek', name: 'DeepSeek' });
      // 造 305 条（超过一页 300）：模拟"页面停在旧序号后，断线期间新增超过一页"
      for (let i = 1; i <= 305; i += 1) {
        await post('/api/message', { agent: 'deepseek', text: `批量 ${i}` });
      }
      const all = await state('?limit=400');
      assert.equal(all.stats.latestSeq, 305);

      // 游标停在 0 之后不久：since=5 时应取"最早的 300 条"（6..305 的前 300 条 = 6..305 中最早 300）
      const page1 = await state('?limit=300&since=5');
      assert.equal(page1.messages.length, 300);
      assert.equal(page1.messages[0].seq, 6, 'since>0 必须从最早开始，否则中间会永久缺号');
      assert.equal(page1.messages[299].seq, 305);

      // 游标推进到 305 之后应返回空页（表示补拉已取完）
      const page2 = await state('?limit=300&since=305');
      assert.equal(page2.messages.length, 0, '取完后应返回空页');

      // 关键断言：一次补拉必须给出 6..305 **连续且完整**，不能跳过中间任何一条
      const ids = page1.messages.map((m) => m.seq);
      assert.deepEqual(ids, [...new Set(ids)], '不应有重复');
      assert.deepEqual(
        ids,
        Array.from({ length: 300 }, (_, i) => i + 6),
        'since>0 时必须从最早开始连续返回，否则断线期间的中间留言会永久缺失',
      );
    },
  );
});

test('同步：服务端下发 instanceId（前端据此识别重启并全量重同步）', async () => {
  await withBoard(async ({ state }) => {
    const payload = await state();
    assert.ok(payload.board.instanceId, 'state 必须带 instanceId');
    assert.ok(payload.board.startedAt, 'state 必须带 startedAt');
  });
});

test('唤醒：长轮询连接断开后，点名不会被投给已断开的等待者', async () => {
  await withBoard(async ({ base, join, post }) => {
    await join({ agent: 'deepseek', name: 'DeepSeek' });
    await join({ agent: 'marvis', name: 'Marvis' });

    // 模拟成员进程被杀：长轮询连接被中断，服务端应立刻撤掉这个 waiter
    const controller = new AbortController();
    const poll = fetch(`${base}/api/inbox?agent=marvis&wait=25`, { signal: controller.signal }).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort();
    await poll;
    await new Promise((resolve) => setTimeout(resolve, 400));

    const asked = await (await post('/api/message', { agent: 'deepseek', text: '@marvis 请确认。' })).json();
    assert.equal(
      asked.delivery[0].state,
      'queued',
      '没有活的等待者时应入队，而不是把信件交给已断开的连接（那会显示已送达却无人处理）',
    );
  });
});

test('投递：送达后长期没有确认 → 判定信封丢失并重投', async () => {
  await withBoard(
    async ({ base, join, post, state }) => {
      await join({ agent: 'deepseek', name: 'DeepSeek' });
      await join({ agent: 'marvis', name: 'Marvis' });

      const waiting = fetch(`${base}/api/inbox?agent=marvis&wait=3`).then((r) => r.json());
      await new Promise((resolve) => setTimeout(resolve, 200));
      const asked = await (await post('/api/message', { agent: 'deepseek', text: '@marvis 请确认。' })).json();
      assert.equal(asked.delivery[0].state, 'delivered');
      await waiting; // 成员取走了信封，但从不回"处理中"

      await new Promise((resolve) => setTimeout(resolve, 4000));
      const payload = await state();
      const record = payload.messages.find((m) => m.id === asked.message.id).delivery[0];
      assert.equal(record.state, 'queued', '未确认应判定丢失并重投，而不是一直挂在"已送达"');
      assert.match(record.note, /未确认/);
    },
    { delivery: { leaseSeconds: 60, maxAttempts: 2, sweepSeconds: 1, ackTimeoutSeconds: 1 } },
  );
});

test('投递：从队列取件时，投递状态更新为已送达', async () => {
  await withBoard(async ({ base, join, post, state }) => {
    await join({ agent: 'deepseek', name: 'DeepSeek' });
    await join({ agent: 'marvis', name: 'Marvis' });

    const asked = await (await post('/api/message', { agent: 'deepseek', text: '@marvis 请确认。' })).json();
    assert.equal(asked.delivery[0].state, 'queued', '无人监听时应先入队');

    const inbox = await (await fetch(`${base}/api/inbox?agent=marvis&wait=1`)).json();
    assert.equal(inbox.wake.seq, asked.message.seq);

    const payload = await state();
    const record = payload.messages.find((m) => m.id === asked.message.id).delivery[0];
    assert.equal(record.state, 'delivered', '从队列取走信件后，投递状态必须推进为已送达（否则面板永远显示待投递）');
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
