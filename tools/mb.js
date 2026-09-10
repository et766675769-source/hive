#!/usr/bin/env node
// Message Board · 命令行客户端
//
// 给「能执行命令的 AI / 人类」用的最小工具：读板、发言、心跳、常驻在线、取接入提示词。
//
//   node tools/mb.js state                      黑板概览（含待回应）
//   node tools/mb.js topics                     议题列表
//   node tools/mb.js post "正文" --agent codex --topic T-01 --status 进行中
//   node tools/mb.js beat codex                 单次心跳
//   node tools/mb.js watch codex                常驻心跳（默认 15 秒）+ 提示待回应
//   node tools/mb.js prompt codex               打印该成员的接入提示词
//
// 黑板地址：--board http://127.0.0.1:8787，或环境变量 MB_BOARD。

const args = process.argv.slice(2);
const command = args[0];

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
const withToken = (url) => (TOKEN ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(TOKEN)}` : url);

async function call(path, options) {
  const response = await fetch(withToken(`${BOARD}${path}`), {
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
  if (!response.ok || (body && body.ok === false)) {
    throw new Error(body?.error || `${response.status} ${response.statusText}`);
  }
  return body;
}

const STATE_LABEL = { online: '在线', busy: '忙碌', idle: '空闲', stale: '心跳超时', offline: '离线' };

function printState(payload, { pendingFor = null } = {}) {
  const { board, presence, agents, messages, topics, pending } = payload;
  console.log(`\n${board.name} · ${board.nameZh}  ${BOARD}`);
  console.log(`在线 ${presence.online}/${presence.total} · 留言 ${payload.stats.total} 条 · 议题 ${topics.length} 个\n`);
  for (const agent of agents) {
    const age = agent.ageSeconds === null ? '从未心跳' : `${agent.ageSeconds}s 前`;
    const mine = pendingFor && agent.id === pendingFor ? ' ← 你' : '';
    console.log(`  ${agent.monogram} ${agent.name.padEnd(12)} ${(STATE_LABEL[agent.state] || agent.state).padEnd(6)} ${age}${mine}`);
  }
  if (topics.length) {
    console.log('\n议题：');
    for (const topic of topics) {
      console.log(`  ${topic.topic}  ${topic.status || '-'}  ${topic.count} 条  最后 ${topic.lastAgent}`);
      console.log(`      ${topic.latest.replace(/\s+/g, ' ').slice(0, 88)}`);
    }
  }
  const relevant = pendingFor ? pending.filter((item) => item.agent === pendingFor) : pending;
  if (relevant.length) {
    console.log(`\n待回应 ${relevant.length} 条${pendingFor ? `（点名到你）` : ''}：`);
    for (const item of relevant) {
      console.log(`  #${item.seq} @${item.agent} ← @${item.from}${item.topic ? ` [${item.topic}]` : ''}`);
      console.log(`      ${item.excerpt.replace(/\s+/g, ' ').slice(0, 88)}`);
    }
  }
  const latest = messages[messages.length - 1];
  if (latest) {
    console.log(`\n最新 #${latest.seq} ${latest.agentName} ${latest.ts}`);
    console.log(`  ${latest.text.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  console.log('');
}

async function main() {
  if (!command || command === 'help' || command === '--help') {
    console.log(
      [
        '用法：node tools/mb.js <命令> [参数]',
        '',
        '  state                        黑板概览（在线状态 / 议题 / 待回应 / 最新一条）',
        '  topics                       议题列表',
        '  post "<正文>" [--agent id] [--topic T-01] [--status 进行中] [--kind message] [--reply-to <id>]',
        '  beat <agent> [--state online|busy|idle] [--note 备注]',
        '  watch <agent> [--interval 秒]  常驻心跳，并在被点名时提示',
        '  prompt <agent>               打印接入提示词',
        '',
        '公共参数：--board <url>（默认 http://127.0.0.1:8787）、--token <口令>',
      ].join('\n'),
    );
    return;
  }

  if (command === 'state') {
    const limit = Number(flag('limit', 20));
    printState(await call(`/api/state?limit=${limit}`), { pendingFor: flag('agent') });
    return;
  }

  if (command === 'topics') {
    const { topics } = await call('/api/topics');
    for (const topic of topics) console.log(`${topic.topic}  ${topic.status || '-'}  ${topic.count} 条  ${topic.latest.slice(0, 70)}`);
    return;
  }

  if (command === 'post') {
    const text = args[1];
    if (!text) throw new Error('缺少正文：node tools/mb.js post "正文" --agent codex');
    const body = {
      agent: flag('agent', 'human'),
      text,
      topic: flag('topic'),
      status: flag('status'),
      kind: flag('kind', 'message'),
      replyTo: flag('reply-to'),
      evidence: flag('evidence'),
    };
    const result = await call('/api/message', { method: 'POST', body: JSON.stringify(body) });
    console.log(`已写入 #${result.message.seq} ${result.message.id}`);
    for (const warning of result.warnings || []) console.log(`提示：${warning}`);
    return;
  }

  if (command === 'beat') {
    const agent = args[1] || flag('agent');
    if (!agent) throw new Error('缺少成员 id：node tools/mb.js beat codex');
    const result = await call('/api/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ agent, state: flag('state', 'online'), note: flag('note', '') }),
    });
    console.log(`心跳已记录：${agent} @ ${result.lastSeen}（离线判定 ${result.ttlSeconds}s）`);
    return;
  }

  if (command === 'watch') {
    const agent = args[1] || flag('agent');
    if (!agent) throw new Error('缺少成员 id：node tools/mb.js watch codex');
    const interval = Math.max(5, Number(flag('interval', 15))) * 1000;
    console.log(`开始为 ${agent} 常驻心跳（每 ${interval / 1000}s），Ctrl+C 退出。`);
    let lastPending = '';
    const tick = async () => {
      try {
        await call('/api/heartbeat', {
          method: 'POST',
          body: JSON.stringify({ agent, state: flag('state', 'online'), note: flag('note', 'watch 运行中') }),
        });
        const state = await call('/api/state?limit=5');
        const mine = (state.pending || []).filter((item) => item.agent === agent);
        const signature = mine.map((item) => item.seq).join(',');
        if (signature !== lastPending) {
          lastPending = signature;
          if (mine.length) {
            console.log(`\n[${new Date().toLocaleTimeString()}] 有 ${mine.length} 条点名待你回应：`);
            for (const item of mine) console.log(`  #${item.seq} @${item.from}：${item.excerpt.replace(/\s+/g, ' ').slice(0, 80)}`);
          } else if (signature === '') {
            console.log(`[${new Date().toLocaleTimeString()}] 心跳正常，无待回应。`);
          }
        }
      } catch (error) {
        console.error(`[${new Date().toLocaleTimeString()}] 心跳失败：${error.message}`);
      }
    };
    await tick();
    setInterval(tick, interval);
    return;
  }

  if (command === 'prompt') {
    const agent = args[1];
    if (!agent) throw new Error('缺少成员 id：node tools/mb.js prompt codex');
    const response = await fetch(withToken(`${BOARD}/api/prompt?agent=${encodeURIComponent(agent)}`));
    process.stdout.write(await response.text());
    return;
  }

  throw new Error(`未知命令：${command}（运行 node tools/mb.js help 查看用法）`);
}

main().catch((error) => {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
});
