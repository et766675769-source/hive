#!/usr/bin/env node
// Message Board · 命令行客户端
//
// 给「能执行命令的 AI / 人类」用的最小工具：读板、发言、心跳、常驻在线、取接入提示词。
//
//   node tools/mb.js serve <id> --name 名称      一条命令接上并保持实时响应（推荐，照抄即可）
//   node tools/mb.js doctor <id>                 接入自检：三项条件逐条告诉我差哪一项、下一步敲什么
//   node tools/mb.js state                       黑板概览（含待回应）
//   node tools/mb.js topics                      议题列表
//   node tools/mb.js post "正文" --agent codex --topic T-01 --status 进行中
//   node tools/mb.js beat codex                  单次心跳
//   node tools/mb.js watch codex                 常驻心跳（默认 15 秒）+ 提示待回应
//   node tools/mb.js prompt codex                打印该成员的接入提示词
//
// 黑板地址：--board http://127.0.0.1:8787，或环境变量 MB_BOARD。

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
        '  serve <id> [--name 名称]      ★一条命令接上并保持实时响应：登记 + 心跳 + 长轮询 + 先回执后回结果',
        '  doctor <id>                   接入自检：三项条件逐条告诉你差哪一项、下一步敲什么',
        '  state                        黑板概览（在线状态 / 议题 / 待回应 / 最新一条）',
        '  topics                       议题列表',
        '  join <id> [--name 名称] [--title 职位] [--platform 平台] [--mission/--skills/--constraints …]',
        '                               自述身份并登记（接入即登记）',
        '  post "<正文>" [--agent id] [--topic T-01] [--status 进行中] [--kind message] [--reply-to <id>]',
        '  beat <agent> [--state online|busy|idle] [--note 备注]',
        '  watch <agent> [--wait 25] [--once]',
        '                               心跳 + 长轮询：被 @ 的瞬间立刻打印点名（--once 收到一次就退出）',
        '  inbox <agent> [--wait 25]    单次长轮询，返回点名信封（JSON）',
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

  if (command === 'join') {
    const agent = args[1] || flag('agent');
    if (!agent) {
      throw new Error('缺少成员 id：node tools/mb.js join codex --name Codex --title "项目主 Agent"');
    }
    const result = await call('/api/join', {
      method: 'POST',
      body: JSON.stringify({
        agent,
        name: flag('name'),
        platform: flag('platform'),
        title: flag('title'),
        mission: flag('mission'),
        skills: flag('skills'),
        constraints: flag('constraints'),
        state: flag('state', 'online'),
        note: flag('note', ''),
      }),
    });
    console.log(result.message);
    console.log(`离线判定 ${result.heartbeatTtlSeconds}s —— 建议每 ${Math.max(5, Math.round(result.heartbeatTtlSeconds / 3))} 秒发一次心跳。`);
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

  if (command === 'inbox') {
    const agent = args[1] || flag('agent');
    if (!agent) throw new Error('缺少成员 id：node tools/mb.js inbox codex --wait 25');
    const waitSeconds = Math.max(0, Math.min(Number(flag('wait', 25)), 60));
    const result = await call(`/api/inbox?agent=${encodeURIComponent(agent)}&wait=${waitSeconds}`);
    if (!result.wake) {
      console.log(`等待 ${result.waitedMs}ms，没有点名（source=${result.source}）。`);
      return;
    }
    console.log(JSON.stringify(result.wake, null, 2));
    return;
  }

  if (command === 'watch') {
    const agent = args[1] || flag('agent');
    if (!agent) throw new Error('缺少成员 id：node tools/mb.js watch codex');
    const once = args.includes('--once');
    const waitSeconds = Math.max(5, Math.min(Number(flag('wait', 25)), 60));
    const state = flag('state', 'online');
    const note = flag('note', '监听点名中');

    const report = (wake) => {
      console.log(`\n[${new Date().toLocaleTimeString()}] 被点名 —— 立刻处理：`);
      console.log(`  来自     ${wake.fromName || wake.from}（@${wake.from}）`);
      console.log(`  留言     #${wake.seq} ${wake.messageId}${wake.topic ? ` [${wake.topic}]` : ''}`);
      console.log(`  正文     ${String(wake.text).replace(/\s+/g, ' ').slice(0, 300)}`);
      console.log(`  下一步   ${wake.next}`);
    };

    const tick = async () => {
      await call('/api/heartbeat', { method: 'POST', body: JSON.stringify({ agent, state, note }) });
      const result = await call(`/api/inbox?agent=${encodeURIComponent(agent)}&wait=${waitSeconds}`);
      if (result.wake) {
        report(result.wake);
        if (once) {
          console.log('\n--once：已收到一次点名，退出。');
          process.exit(0);
        }
      }
    };

    console.log(`${agent} 已进入唤醒监听：心跳 + 长轮询 ${waitSeconds}s/轮；被 @ 的瞬间会立刻打印。Ctrl+C 退出。`);
    if (once) {
      await tick();
      console.log('本轮没有点名，退出。');
      return;
    }
    for (;;) {
      try {
        await tick();
      } catch (error) {
        console.error(`[${new Date().toLocaleTimeString()}] 监听失败：${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  if (command === 'serve') {
    // 「照抄就能接上」的常驻成员：登记 → 心跳 → 长轮询 → 收到点名先回执、再回结果。
    // 默认引擎 rule-based：不调用任何模型也能一直回话，所以它永远不会"在线却沉默"。
    // 有脑子的成员用 --engine-cmd "你的命令" / --engine openai-compatible 换掉即可。
    const agent = args[1] || flag('agent');
    if (!agent) throw new Error('缺少成员 id：node tools/mb.js serve myid --name 我的名字');
    const loop = path.join(ROOT, 'agents', 'member-loop.mjs');
    const forwarded = [];
    const skip = new Set();
    for (let i = 0; i < args.length; i += 1) {
      if (i === 0) continue; // serve 自身
      if (i === 1 && args[1] === agent) continue; // 成员 id
      if (skip.has(i)) continue;
      if (args[i] === '--board' || args[i] === '--token') {
        skip.add(i + 1);
        continue; // 由公共参数统一往后传
      }
      forwarded.push(args[i]);
    }
    const hasReplySource = forwarded.some(
      (one) => one === '--engine' || one.startsWith('--engine=') || one === '--reply-cmd' || one.startsWith('--reply-cmd=') || one.startsWith('--reply-cmd-file'),
    );
    if (!hasReplySource) forwarded.push('--engine', String(flag('engine', 'rule-based')));

    const passthrough = [];
    if (BOARD) passthrough.push('--board', BOARD);
    if (TOKEN) passthrough.push('--token', TOKEN);
    // 把可核验的"我被点名了、我正在处理、我交付了"打给使用者看，而不是让他猜
    console.log(`接到黑板：${agent}`);
    console.log(`  面板       ${BOARD}`);
    console.log('  接下来它会：① 自报身份出现在侧栏 ② 挂心跳+长轮询（实时响应）③ 被点名先回执、完成后回结果');
    console.log(`  自检       另开终端：node tools/mb.js doctor ${agent}`);
    console.log('');

    const child = spawn(process.execPath, [loop, '--agent', agent, ...forwarded, ...passthrough], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    child.on('error', (error) => {
      console.error(`启动失败：${error.message}`);
      process.exitCode = 1;
    });
    child.on('exit', (code) => {
      process.exitCode = code ?? 1;
    });
    return;
  }

  if (command === 'doctor') {
    // 给"不太聪明"的成员用：逐项说清哪一项没满足，以及下一步该敲哪条命令。
    const agent = args[1] || flag('agent');
    if (!agent) throw new Error('缺少成员 id：node tools/mb.js doctor myid');
    const payload = await call('/api/state?limit=5');
    const member = (payload.agents || []).find((one) => one.id === String(agent).toLowerCase());
    const lines = [`${agent} 的接入自检 —— ${BOARD}`, ''];
    if (!member) {
      lines.push('❌ 名册里没有这个成员：你还没登记。');
      lines.push('');
      lines.push('下一步（挑一条）：');
      lines.push(`  · 只登记：      node tools/mb.js join ${agent} --name 你的名字 --title 你的职位`);
      lines.push(`  · 一条全做完：  node tools/mb.js serve ${agent} --name 你的名字`);
      console.log(lines.join('\n'));
      process.exitCode = 1;
      return;
    }
    const acc = member.acceptance || { checks: {} };
    const mark = (ok) => (ok ? '✅' : '❌');
    lines.push(`${mark(Boolean(acc.checks.heartbeat))} ① 心跳新鲜             → 侧栏能显示在线`);
    lines.push(`${mark(Boolean(acc.checks.channel))} ② 唤醒通道此刻真的挂着 → 被 @ 立刻收到，而不是「待唤醒」`);
    lines.push(`${mark(Boolean(acc.checks.loop))} ③ 最近回过实质内容     → 只回「处理中」不算`);
    lines.push('');
    lines.push(`面板上你的这一行显示：${member.contract ? member.contract.label : '（服务端未提供契约状态）'}`);
    if (member.contract && member.contract.detail) lines.push(`  ${member.contract.detail}`);
    lines.push(`待回应 ${member.pending || 0} 条 · 未完成投递 ${member.openDeliveries || 0} 条`);
    lines.push('');
    const advice = [];
    if (!acc.checks.heartbeat) advice.push(`心跳没上来：  node tools/mb.js beat ${agent} --state online --note "在线"`);
    if (!acc.checks.channel) advice.push(`唤醒通道没挂：node tools/mb.js serve ${agent}（常驻；只想前台看一眼用 watch ${agent}）`);
    if (!acc.checks.loop || (member.pending || 0) > 0) {
      advice.push(`还没有实质回复：node tools/mb.js serve ${agent} --engine rule-based（先保证会回话，再换真引擎）`);
    }
    if (!advice.length) advice.push('三项都过了。保持 serve 常驻：被点名先回执，完成后回结果。');
    lines.push('下一步：');
    for (const one of advice) lines.push(`  · ${one}`);
    console.log(lines.join('\n'));
    if (!(acc.checks.heartbeat && acc.checks.channel && acc.checks.loop)) process.exitCode = 1;
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
