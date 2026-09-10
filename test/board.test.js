// Message Board · 协议与接口测试（node:test，无第三方依赖）
//
// 运行：npm test
// 若临时目录不可写，可用 MB_TEST_DATA_DIR 指定一个可写目录。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBoardServer } from '../server/index.js';
import { isAcknowledgementOnly, parseMentions, localIso } from '../server/protocol.js';

const dataRoot = process.env.MB_TEST_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'message-board-test-'));
fs.mkdirSync(dataRoot, { recursive: true });

async function withBoard(run) {
  const dataDir = fs.mkdtempSync(path.join(dataRoot, 'board-'));
  const { server, config, store, presence } = createBoardServer({ dataDir, quiet: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (apiPath, body) =>
    fetch(`${base}${apiPath}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    await run({ base, dataDir, config, store, post });
  } finally {
    presence.stop();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('纯函数：@ 提及只认可名册内成员', () => {
  assert.deepEqual(parseMentions('@codex 请看 @unknown 和 @deepseek', ['codex', 'deepseek']), ['codex', 'deepseek']);
  assert.deepEqual(parseMentions('没有提及', ['codex']), []);
});

test('纯函数：只由寒暄组成的回复被判定为空话', () => {
  const tokens = ['收到', '好的', 'ok'];
  assert.equal(isAcknowledgementOnly('收到', tokens), true);
  assert.equal(isAcknowledgementOnly('  好的。 ', tokens), true);
  assert.equal(isAcknowledgementOnly('收到，我核对了三项并复现了问题', tokens), false);
});

test('纯函数：本地时区时间戳带偏移', () => {
  assert.match(localIso(new Date(2026, 8, 10, 21, 0, 0)), /^2026-09-10T21:00:00[+-]\d{2}:\d{2}$/);
});

test('探活接口返回协议与最新序号', async () => {
  await withBoard(async ({ base }) => {
    const body = await (await fetch(`${base}/api/health`)).json();
    assert.equal(body.ok, true);
    assert.equal(body.protocol, 'messageboard.protocol.v1');
    assert.equal(body.latestSeq, 0);
  });
});

test('留言：写入成功并落到 JSONL 与 markdown 镜像', async () => {
  await withBoard(async ({ base, dataDir, post }) => {
    const response = await post('/api/message', { agent: 'codex', text: '结论：黑板可用。', topic: 'T-01', status: '进行中' });
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.message.seq, 1);
    assert.equal(body.message.agentName, 'Codex');

    const state = await (await fetch(`${base}/api/state?limit=10`)).json();
    assert.equal(state.messages.length, 1);
    assert.equal(state.topics[0].topic, 'T-01');

    const jsonl = fs.readFileSync(path.join(dataDir, 'messages.jsonl'), 'utf8').trim().split('\n');
    assert.equal(jsonl.length, 1);
    assert.equal(JSON.parse(jsonl[0]).seq, 1);

    const mirror = fs.readFileSync(path.join(dataDir, 'WORKCHAT.md'), 'utf8');
    assert.match(mirror, /Codex/);
    assert.match(mirror, /T-01/);
  });
});

test('留言：非法输入被逐条拒绝', async () => {
  await withBoard(async ({ post }) => {
    const cases = [
      [{ agent: 'codex', text: '' }, 'EMPTY_TEXT'],
      [{ agent: 'ghost', text: '你好' }, 'UNKNOWN_AGENT'],
      [{ agent: 'codex', text: '正文', status: '已完成' }, 'BAD_STATUS'],
      [{ agent: 'codex', text: '正文', kind: 'unknown-kind' }, 'BAD_KIND'],
      [{ agent: 'codex', text: 'key = sk-abcdefghijklmnopqrstuvwx' }, 'SUSPECTED_SECRET'],
    ];
    for (const [payload, code] of cases) {
      const response = await post('/api/message', payload);
      assert.equal(response.status, 400, JSON.stringify(payload));
      assert.equal((await response.json()).code, code);
    }
  });
});

test('点名：空话回复被标记，实质回复消除待回应', async () => {
  await withBoard(async ({ base, post }) => {
    const asked = await (await post('/api/message', { agent: 'human', text: '@codex 请确认黑板可用性', topic: 'T-01' })).json();

    let state = await (await fetch(`${base}/api/state?limit=10`)).json();
    assert.deepEqual(state.pending.map((item) => item.agent), ['codex']);

    const ack = await (await post('/api/message', { agent: 'codex', text: '收到', topic: 'T-01' })).json();
    assert.deepEqual(ack.message.flags, ['ACK_ONLY']);
    assert.equal(ack.warnings.length, 1);

    state = await (await fetch(`${base}/api/state?limit=10`)).json();
    assert.equal(state.pending.length, 1, '空话回复不应消除待回应');

    await post('/api/message', {
      agent: 'codex',
      text: '已确认：探活返回 200，留言写入成功。',
      topic: 'T-01',
      replyTo: asked.message.id,
    });
    state = await (await fetch(`${base}/api/state?limit=10`)).json();
    assert.equal(state.pending.length, 0);
  });
});

test('心跳：新鲜心跳为在线，未知成员被拒绝', async () => {
  await withBoard(async ({ base, post }) => {
    const bad = await post('/api/heartbeat', { agent: 'ghost' });
    assert.equal(bad.status, 400);

    await post('/api/heartbeat', { agent: 'workbuddy', note: '守夜轮询' });
    const state = await (await fetch(`${base}/api/state?limit=1`)).json();
    const workbuddy = state.agents.find((agent) => agent.id === 'workbuddy');
    assert.equal(workbuddy.state, 'online');
    assert.equal(workbuddy.note, '守夜轮询');
    assert.ok(state.presence.online >= 1);
  });
});

test('发言自动补记心跳', async () => {
  await withBoard(async ({ base, post }) => {
    await post('/api/message', { agent: 'marvis', text: 'Marvis 报到。' });
    const state = await (await fetch(`${base}/api/state?limit=1`)).json();
    assert.equal(state.agents.find((agent) => agent.id === 'marvis').state, 'online');
  });
});

test('接入提示词包含身份、地址与纪律', async () => {
  await withBoard(async ({ base }) => {
    const response = await fetch(`${base}/api/prompt?agent=codex`);
    const text = await response.text();
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.match(text, /身份：Codex · id: codex/);
    assert.match(text, /\/api\/heartbeat/);
    assert.match(text, /被 @ 必须实质回复/);
    assert.match(text, /Message Board 留言/);
  });
});

test('名册之外的提示词请求返回通用接入说明', async () => {
  await withBoard(async ({ base }) => {
    const text = await (await fetch(`${base}/api/prompt?agent=nobody`)).text();
    assert.match(text, /你目前还没有黑板身份/);
  });
});

test('黑板页面与静态资源可访问', async () => {
  await withBoard(async ({ base }) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Message Board/);
    const css = await fetch(`${base}/board.css`);
    assert.equal(css.status, 200);
    const missing = await fetch(`${base}/../server/index.js`);
    assert.ok(missing.status === 403 || missing.status === 404);
  });
});

test('存储：序号只增不改，重复读取结果稳定', async () => {
  await withBoard(async ({ dataDir, store }) => {
    store.append({ agent: { id: 'human', name: 'ET', title: '人类主控' }, text: '一', mentions: [], flags: [] });
    store.append({ agent: { id: 'human', name: 'ET', title: '人类主控' }, text: '二', mentions: [], flags: [] });
    assert.deepEqual(store.list({ limit: 10 }).map((msg) => msg.seq), [1, 2]);
    const before = fs.readFileSync(path.join(dataDir, 'messages.jsonl'), 'utf8');
    assert.equal(before.trim().split('\n').length, 2);
    assert.deepEqual(store.list({ limit: 10 }).map((msg) => msg.text), ['一', '二']);
  });
});
