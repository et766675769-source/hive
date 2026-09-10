#!/usr/bin/env node
// Message Board · 旧文件通道桥接（aitc.filechannel.v1 ⇄ messageboard.protocol.v1）
//
// 让旧工作台与旧成员（WorkBuddy 等被动轮询者）不必改代码就能参与新黑板：
//
//   入站：tasks/<task-id>.in.json（kind=workchat） → 追加为黑板留言并 @ 目标成员
//   出站：黑板出现该成员的回复                → 写出同名 <task-id>.out.json（旧信封）
//   镜像：黑板收到心跳                        → 刷新 _heartbeat.<AgentName>.json
//
// 幂等以「黑板事实」为准，而不是桥接进程的内存：
//   黑板留言的 client.task_id 已是该任务 → 直接认领，绝不重复投递（重启后同样成立）；
//   <task-id>.out.json 已存在            → 视为已完成，跳过。
//
// 纪律（与旧协议一致）：先写 .tmp 再原子重命名；不删除对端未消费的 .in.json；
// 找不到名册成员时只告警、不伪造身份发言；带 BOM 的 JSON 也照收。
//
// 用法：
//   node bridges/file-channel.js --tasks <任务目录> [--board http://127.0.0.1:8787]
//                                [--as human] [--interval 3] [--once] [--quiet]

import fs from 'node:fs';
import path from 'node:path';

import { localIso, stripBom } from '../server/protocol.js';

const LEGACY_SCHEMA = 'aitc.filechannel.v1';

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
const TASKS_DIR = flag('tasks') || process.env.AITC_FILE_CHANNEL_DIR || path.join(process.cwd(), 'tasks');
const AS_AGENT = flag('as', 'human');
const INTERVAL_MS = Math.max(1, Number(flag('interval', 3))) * 1000;
const ONCE = args.includes('--once');
const QUIET = args.includes('--quiet');

const withToken = (url) => (TOKEN ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(TOKEN)}` : url);

function log(...parts) {
  if (!QUIET) console.log(`[file-channel ${new Date().toLocaleTimeString()}]`, ...parts);
}

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

function writeAtomic(file, content) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

const norm = (value) => String(value || '').trim().toLowerCase();

/** 读取并解析任务文件；带 BOM 也照收，解析失败只告警一次（对端可能仍在写）。 */
const warned = new Set();
function readTask(file, taskId) {
  try {
    return JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    if (!warned.has(taskId)) {
      warned.add(taskId);
      log(`跳过 ${taskId}：${error.message}（若刚写入，属正常竞态，下一轮会重试）`);
    }
    return null;
  }
}

/** 把 in.json 里的 agent 信息映射到黑板名册成员。 */
function resolveTarget(task, agents) {
  const raw = task?.agent || {};
  const candidates = [raw.id, raw.name, raw.platform].filter(Boolean).map(norm);
  for (const agent of agents) {
    if (candidates.includes(norm(agent.id)) || candidates.includes(norm(agent.name))) return agent;
  }
  return null;
}

/** 拉取一次黑板快照：在线状态 + 留言 + 已有任务的认领索引。 */
async function snapshot() {
  const state = await call('/api/state?limit=300');
  const claimed = new Map();
  for (const message of state.messages || []) {
    const taskId = message.client && message.client.task_id;
    if (taskId && !claimed.has(taskId)) claimed.set(taskId, message);
  }
  return { agents: state.agents || [], messages: state.messages || [], claimed };
}

async function syncInbound(snap) {
  if (!fs.existsSync(TASKS_DIR)) return;
  for (const name of fs.readdirSync(TASKS_DIR).filter((item) => item.endsWith('.in.json'))) {
    const taskId = name.slice(0, -'.in.json'.length);
    if (fs.existsSync(path.join(TASKS_DIR, `${taskId}.out.json`))) continue;

    // 幂等：黑板已认领过该任务 → 只登记，不重复投递
    const existing = snap.claimed.get(taskId);
    if (existing) {
      pending.set(taskId, {
        messageId: existing.id,
        seq: existing.seq,
        target: existing.mentions[0] || null,
        targetName: existing.mentions[0] || '',
      });
      continue;
    }

    const task = readTask(path.join(TASKS_DIR, name), taskId);
    if (!task || task.kind !== 'workchat') continue;

    const target = resolveTarget(task, snap.agents);
    if (!target) {
      log(`跳过 ${taskId}：目标成员 ${task?.agent?.name || task?.agent?.id || '未知'} 不在黑板名册中`);
      continue;
    }

    const text = `${task.prompt || '(空任务)'}\n\n@${target.id} 请在下一次唤醒时回复本任务。`;
    const posted = await call('/api/message', {
      method: 'POST',
      body: JSON.stringify({ agent: AS_AGENT, text, kind: 'handoff', client: { bridge: 'file-channel', task_id: taskId } }),
    });
    pending.set(taskId, { messageId: posted.message.id, seq: posted.message.seq, target: target.id, targetName: target.name });
    log(`入站 ${taskId} → 黑板 #${posted.message.seq}，点名 @${target.id}`);
  }
}

/** 等待出站的任务：taskId → { messageId, seq, target, targetName } */
const pending = new Map();

function syncOutbound(snap) {
  for (const [taskId, entry] of [...pending.entries()]) {
    const outPath = path.join(TASKS_DIR, `${taskId}.out.json`);
    if (fs.existsSync(outPath)) {
      pending.delete(taskId);
      continue;
    }
    if (!entry.target) continue;
    const reply = snap.messages.find((message) => message.seq > entry.seq && message.agent === entry.target);
    if (!reply) continue;

    const envelope = {
      schema: LEGACY_SCHEMA,
      task_id: taskId,
      kind: 'workchat',
      channel: 'file',
      native: false,
      status: 'completed',
      reply: reply.text,
      error: '',
      result: { report: reply.text, board_message_id: reply.id, board_seq: reply.seq },
      usage: { input_tokens: 0, output_tokens: 0, input_rate: 0, output_rate: 0 },
      agent: reply.agentName || entry.targetName,
      completed_at: localIso(),
    };
    writeAtomic(outPath, JSON.stringify(envelope, null, 2));
    pending.delete(taskId);
    log(`出站 ${taskId} ← 黑板 #${reply.seq}（${envelope.agent}）`);
  }
}

/** 黑板心跳 → 旧协议 _heartbeat.<AgentName>.json（仅内容变化时写）。 */
function mirrorHeartbeats(snap) {
  if (!fs.existsSync(TASKS_DIR)) return;
  for (const agent of snap.agents) {
    if (!agent.lastSeen || agent.state === 'offline') continue;
    const file = path.join(TASKS_DIR, `_heartbeat.${agent.name}.json`);
    const payload = JSON.stringify(
      { schema: LEGACY_SCHEMA, agent: agent.name, last_seen: agent.lastSeen, state: 'online' },
      null,
      0,
    );
    try {
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === payload) continue;
      writeAtomic(file, payload);
    } catch (error) {
      log(`心跳镜像失败 ${agent.name}：${error.message}`);
    }
  }
}

async function cycle() {
  const snap = await snapshot();
  await syncInbound(snap);
  syncOutbound(snap);
  mirrorHeartbeats(snap);
}

async function main() {
  log(`桥接启动：任务目录 ${TASKS_DIR} → 黑板 ${BOARD}（以 ${AS_AGENT} 身份投递）`);
  if (!fs.existsSync(TASKS_DIR)) {
    fs.mkdirSync(TASKS_DIR, { recursive: true });
    log(`任务目录不存在，已创建：${TASKS_DIR}`);
  }
  const roster = await call('/api/config');
  log(`名册：${roster.agents.map((agent) => `${agent.name}(${agent.id})`).join(' · ')}`);

  if (ONCE) {
    await cycle();
    log('单轮执行完成（--once）。');
    return;
  }
  await cycle();
  setInterval(() => cycle().catch((error) => log(`轮询异常：${error.message}`)), INTERVAL_MS);
}

main().catch((error) => {
  console.error(`桥接失败：${error.message}`);
  process.exitCode = 1;
});
