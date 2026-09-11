#!/usr/bin/env node
// Message Board · 哨兵（sentinel）
//
// 黑板上的失败模式不是"进程挂了"，而是**看着一切正常却没有人回话**：
//   · 某个成员的心跳一直在刷新，长轮询也挂着，可点名永远停在「待回应」；
//   · 投递账本里一堆 expired，面板上却显示「在线」；
//   · 一个不由任何人托管的外部客户端占着在线状态，同时没有任何托管进程在跑。
// watchdog 管的是"没在监听就拉起"，它对这种情况无能为力——它看到的是"在监听"。
//
// 哨兵补上这一段：定期巡检每一个成员，回答三个问题
//   1) 谁在线却沉默？          （有点名超过阈值还没实质回复，且没有正在进行的生成）
//   2) 谁只不过是在挂心跳？    （心跳 ✓ 但 24 小时内没有任何实质回复）
//   3) 谁的点名已经作废了？    （投递过期计数）
// 然后把结论**写回黑板**（只在该状态变化时发言，不刷屏），并落盘 data/sentinel-status.json。
//
// 反馈之外还有一只手：当结论是「在线但沉默」而该成员在 desktop/watchdog-members.json
// 里有托管配置时，哨兵会按那份配置把**可托管通道**拉起来（可 --no-takeover 关掉）。
// 于是"外部客户端占着在线、却从不回话"这种情况会自己收敛。
//
// 用法：
//   node tools/sentinel.mjs                       # 常驻巡检（默认 60 秒一轮）
//   node tools/sentinel.mjs --once --json          # 跑一轮，输出 JSON（测试/CI 用）
//   node tools/sentinel.mjs --once --dry-run       # 只报告，不发言、不接管
//   node tools/sentinel.mjs --silent-minutes 20 --cooldown-minutes 90
//
// 参数（环境变量同名，前缀 MB_SENTINEL_）：
//   --board URL          黑板地址（默认 http://127.0.0.1:8787）
//   --interval N         巡检间隔秒（默认 60）
//   --silent-minutes N   超过多久没回话算"沉默"（默认 15）
//   --cooldown-minutes N 同一成员的两次托管接管最短间隔（默认 60）
//   --expired-window N   投递过期计数的观察窗口小时数（默认 24）
//   --no-takeover        只巡检与反馈，不启动任何进程
//   --dry-run            不发言、不接管、只打印与落盘
//   --once               只跑一轮后退出
//   --json               --once 时把结论打到 stdout（机器可读）
//   --fail-on-alert      --once 时若有 alert 级结论则以退出码 1 结束（CI 用）

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluateLock, readLock } from './channel-lock.mjs';
import { CONTRACT, humanSeconds } from '../server/contract.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function flag(name, fallback = null) {
  const inline = args.find((item) => item.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

const env = (name) => process.env[`MB_SENTINEL_${name}`] || '';

// 阈值优先从 CLI/环境变量取，其次读 board.config.json 的 "sentinel" 段，
// 最后才是内置默认值 —— 让"黑板怎么配"和"哨兵怎么判"在同一个文件里可查。
const CONFIG_FILE = process.env.MB_CONFIG || path.join(ROOT, 'board.config.json');
const fileConfig = (() => {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).sentinel || {};
  } catch {
    return {};
  }
})();

const BOARD = (
  flag('board') ||
  env('BOARD') ||
  process.env.MB_BOARD ||
  fileConfig.board ||
  'http://127.0.0.1:8787'
).replace(/\/+$/, '');
const TOKEN = flag('token') || process.env.MB_TOKEN || '';
const INTERVAL_SECONDS = Math.max(10, Number(flag('interval') || env('INTERVAL') || fileConfig.intervalSeconds || 60));
const SILENT_MINUTES = Math.max(1, Number(flag('silent-minutes') || env('SILENT_MINUTES') || fileConfig.silentMinutes || 15));
const COOLDOWN_MINUTES = Math.max(1, Number(flag('cooldown-minutes') || env('COOLDOWN_MINUTES') || fileConfig.cooldownMinutes || 60));
const EXPIRED_WINDOW_HOURS = Math.max(1, Number(flag('expired-window') || env('EXPIRED_WINDOW') || fileConfig.expiredWindowHours || 24));
const TAKEOVER = fileConfig.takeover === false ? false : !args.includes('--no-takeover');
const DRY_RUN = args.includes('--dry-run');
const ONCE = args.includes('--once');
const AS_JSON = args.includes('--json');
const QUIET = args.includes('--quiet');
const FAIL_ON_ALERT = args.includes('--fail-on-alert');

const STATUS_FILE = flag('status-file') || env('STATUS_FILE') || path.join(ROOT, 'data', 'sentinel-status.json');
const LOG_DIR = flag('log-dir') || path.join(ROOT, 'data', 'logs');
const MEMBERS_FILE = flag('members-file') || env('MEMBERS_FILE') || path.join(ROOT, 'desktop', 'watchdog-members.json');
// 托管通道的归属锁目录（每个成员一个子目录，与 agent-runner 的 --runtime 对应）
const RUNTIME_ROOT = flag('runtime-root') || env('RUNTIME_ROOT') || path.join(ROOT, 'data', 'runner');

const SENTINEL_ID = 'sentinel';
// 哨兵的身份来自 board.config.json 的预置项（kind=operator、hidden）：它不占名册成员位，
// 也不能被 @（前端按 kind 过滤），但发言时姓名照样可读。
const SENTINEL_IDENTITY = {
  name: '哨兵',
  title: '在线状态与投递巡检',
  platform: 'Message Board 巡检',
};

const log = (...parts) => {
  const line = `[sentinel ${new Date().toLocaleString()}] ${parts.join(' ')}`;
  if (!QUIET) console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, 'sentinel.log'), `${line}\n`, 'utf8');
  } catch {
    /* 写不了日志不影响巡检 */
  }
};

const withToken = (url) => (TOKEN ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(TOKEN)}` : url);

async function call(apiPath, options = {}, board = BOARD) {
  const response = await fetch(withToken(`${board}${apiPath}`), {
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

/* ── 纯函数：结论怎么算（可测试，不碰网络与磁盘）──────────── */

/**
 * 把一个成员的快照判成若干条结论。
 *
 * 主判据是**契约**（server/contract.js 给出的 member.contract）：
 * 点名有没有被取件、有没有回执、有没有在预算内交付。
 * 「在线」只是参考信息——挂个心跳就能骗过去，契约骗不过去。
 * 只有当服务端没给出契约字段（旧版黑板）时，才退回"沉默多久"的启发式。
 *
 * @param {object} member /api/state 里的成员卡
 * @param {{ nowMs: number, silentMinutes: number, pending?: object[] }} options
 */
export function classifyMember(member, { nowMs, silentMinutes, pending = [] }) {
  const findings = [];
  const mine = pending.filter((item) => item.agent === member.id);
  const waiting = member.respondMode === 'manual';
  // "正在干活"只认成员自己报的 busy。
  // 注意：不能用「有未完成投递」当依据——排队中的投递（queued/delivered）恰恰是
  // "没人来取"的表现，把它当成在干活，哨兵就会对最该报警的情况保持沉默（实测踩过）。
  const selfBusy = member.declared === 'busy';
  const contract = member.contract || null;

  // ── 主判据：契约违约（没取件 / 没回执 / 没交付）────────────────
  if (contract && contract.severity === 'alert') {
    const code =
      contract.state === CONTRACT.NOT_FETCHED
        ? 'NOT_FETCHED'
        : contract.state === CONTRACT.NO_ACK
          ? 'NO_ACK'
          : contract.state === CONTRACT.OVERDUE
            ? 'OVERDUE'
            : 'CONTRACT_BREACH';
    findings.push({
      code,
      severity: 'alert',
      member: member.id,
      title: contract.label,
      contractState: contract.state,
      ageMinutes: contract.waitingSeconds === null ? null : Math.round(contract.waitingSeconds / 60),
      waitingSeconds: contract.waitingSeconds,
      seqs: mine.map((item) => item.seq),
      detail: `${contract.detail}（进程状态：${member.state}${selfBusy ? '，自报正在处理' : ''}）`,
    });
  }
  // manual 成员等人是它的声明形态，不是故障
  else if (contract && contract.state === CONTRACT.MANUAL) {
    findings.push({
      code: 'MANUAL_WAITING',
      severity: 'info',
      member: member.id,
      title: '需人工唤起',
      waitingSeconds: contract.waitingSeconds,
      detail: `${contract.detail}这是它的声明形态，不是故障。`,
    });
  } else if (!contract && waiting && mine.length) {
    // 旧版黑板没有契约字段时的等价判定
    findings.push({
      code: 'MANUAL_WAITING',
      severity: 'info',
      member: member.id,
      title: '需人工唤起',
      detail: `有 ${mine.length} 条点名在等人类回复（#${mine.map((item) => item.seq).join(', #')}）——这是它的声明形态，不是故障。`,
    });
  }

  // ── 兜底：服务端没给契约字段时（旧版黑板），退回"沉默多久"的启发式 ──────────
  // 契约已经报过违约就别重复报：同一个病灶说两遍只会让人以为是两个问题。
  const contractSpoke = findings.some((finding) => finding.severity === 'alert');
  if (!contract && !contractSpoke && !waiting && mine.length && !selfBusy) {
    const oldestMs = mine.reduce((min, item) => {
      const at = Date.parse(item.at);
      return Number.isFinite(at) ? Math.min(min, at) : min;
    }, Number.POSITIVE_INFINITY);
    const ageMinutes = Number.isFinite(oldestMs) ? Math.round((nowMs - oldestMs) / 60000) : null;
    if (ageMinutes !== null && ageMinutes >= silentMinutes) {
      findings.push({
        code: 'SILENT_WITH_PENDING',
        severity: 'alert',
        member: member.id,
        title: '在线但沉默',
        memberState: member.state,
        ageMinutes,
        seqs: mine.map((item) => item.seq),
        detail: `状态显示「${member.state}」，却有 ${mine.length} 条点名已等 ${ageMinutes} 分钟没有实质回复（#${mine
          .map((item) => item.seq)
          .join(', #')}），且它没有自报「正在处理」。${
          Number(member.openDeliveries) > 0
            ? `账本里还有 ${member.openDeliveries} 条投递未完成——没有人来取的意思。`
            : '投递账本里没有未完成项，说明它连取件都没做。'
        }`,
      });
    }
  }

  // 心跳一直有、但窗口内没有任何实质回复：典型"只挂心跳，不会回话"
  const acc = member.acceptance;
  if (acc && acc.checks && acc.checks.heartbeat && !acc.checks.loop && !waiting) {
    const window = acc.loopWindowHours || 24;
    findings.push({
      code: 'LISTENING_BUT_NEVER_REPLIED',
      severity: 'warn',
      member: member.id,
      title: '只挂心跳',
      detail: `最近 ${window} 小时内有心跳，但没有任何一条实质回复（唤醒通道 ${
        acc.checks.channel ? '✓ 在挂' : '✗ 没有'
      }）——它看起来在线，实际不会回答问题。`,
    });
  }

  const expired = Number(member.deliveryCounts && member.deliveryCounts.expired) || 0;
  if (expired > 0) {
    findings.push({
      code: 'DELIVERIES_EXPIRED',
      severity: 'warn',
      member: member.id,
      title: '点名已作废',
      expired,
      detail: `最近 ${EXPIRED_WINDOW_HOURS} 小时内有 ${expired} 条点名重试用尽仍未得到实质回复（租约到期后账本已把它记为 expired）。`,
    });
  }

  if (member.state !== 'offline' && !member.engine && !waiting && member.kind !== 'operator') {
    findings.push({
      code: 'NO_ENGINE',
      severity: 'info',
      member: member.id,
      title: '未声明引擎',
      detail: '它没有声明「靠什么把点名变成回复」，因此无法判断它是否可能回话；点名它时请以实际回复为准。',
    });
  }

  return findings;
}

/** 整块黑板的结论：board 级 + 每个成员级。 */
export function classifyBoard(state, { nowMs = Date.now(), silentMinutes = SILENT_MINUTES } = {}) {
  const pending = state.pending || [];
  const findings = [];
  for (const member of state.agents || []) {
    findings.push(...classifyMember(member, { nowMs, silentMinutes, pending }));
  }
  const totals = { alert: 0, warn: 0, info: 0 };
  for (const finding of findings) totals[finding.severity] = (totals[finding.severity] || 0) + 1;
  return { findings, totals, pending: pending.length, members: (state.agents || []).length };
}

/**
 * 该不该由哨兵把托管通道拉起来？
 * 条件（缺一不可）：契约违约（没取件 / 没回执 / 没交付）或长时间沉默 +
 * 该成员有托管配置 + 没有健康的托管进程 + 不在冷却期。
 * 最后一条尤其重要：多拉起一个进程不是"更保险"，而是让一次点名刷出两条回复（实测踩过）。
 */
export function planTakeovers(
  findings,
  members,
  { status = {}, nowMs = Date.now(), cooldownMinutes = COOLDOWN_MINUTES, lockOf = () => null, isAlive = undefined } = {},
) {
  const byId = new Map((members || []).map((item) => [item.id, item]));
  const takeovers = [];
  for (const finding of findings) {
    // 契约违约是最硬的证据：点名确实没被履行，不是"看起来像沉默"
    if (finding.severity !== 'alert') continue;
    if (!['NOT_FETCHED', 'NO_ACK', 'OVERDUE', 'CONTRACT_BREACH', 'SILENT_WITH_PENDING'].includes(finding.code)) continue;
    const entry = byId.get(finding.member);
    if (!entry) continue;

    // 有人正当地持有该成员的托管锁 → 它只是在慢，不是在沉默，别抢
    const evaluation = evaluateLock(lockOf(finding.member), isAlive ? { nowMs, isAlive } : { nowMs });
    if (evaluation.state === 'held') {
      takeovers.push({ member: finding.member, ok: false, reason: `已有托管进程在跑，不动它（${evaluation.reason}）` });
      continue;
    }

    const last = Date.parse((status.takeovers && status.takeovers[finding.member]) || '') || 0;
    const waitedMinutes = last ? (nowMs - last) / 60000 : Number.POSITIVE_INFINITY;
    if (waitedMinutes < cooldownMinutes) {
      takeovers.push({ member: finding.member, ok: false, reason: `冷却中（${Math.round(waitedMinutes)}/${cooldownMinutes} 分钟）` });
      continue;
    }
    takeovers.push({
      member: finding.member,
      ok: true,
      reason:
        evaluation.state === 'stale'
          ? `契约没被履行（${finding.title}），且原托管进程看起来卡死了（${evaluation.reason}）`
          : `契约没被履行（${finding.title}），且没有托管进程在跑`,
      start: entry.start,
    });
  }
  return takeovers;
}

/* ── 反馈与接管（有副作用）───────────────────────────────── */

function readJson(file, fallback = null) {
  try {
    // 去掉 BOM：Windows 上记事本/PowerShell 的 Out-File 都会写 BOM，
    // 而 JSON.parse 见到 BOM 直接抛错。少了这一步，托管清单会被静默读成空
    // （哨兵于是永远"没有对应的托管配置"，却看不出为什么）。
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** 读托管清单：容错都要说出来，不能"静默地没有配置"。 */
export function readManagedMembers(file = MEMBERS_FILE, onWarn = log) {
  if (!file || !fs.existsSync(file)) {
    onWarn(`托管清单不存在（${file}）：哨兵只反馈，不会拉起任何通道。`);
    return [];
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch (error) {
    onWarn(`托管清单读不了（${file}）：${error.message}`);
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    onWarn(`托管清单不是合法 JSON（${file}）：${error.message}——本轮按"没有托管配置"处理。`);
    return [];
  }
  const list = Array.isArray(parsed && parsed.members) ? parsed.members : [];
  const usable = list.filter((item) => item && item.id && Array.isArray(item.start) && item.enabled !== false);
  if (list.length && !usable.length) onWarn(`托管清单里没有可用条目（${file}）：每条都需要 id 与 start 数组。`);
  if (!list.length) onWarn(`托管清单是空的（${file}）：哨兵只能反馈，不能接管。`);
  return usable;
}

function readMembers() {
  return readManagedMembers(MEMBERS_FILE);
}

/** 该成员的托管锁内容（运行器目录由 --runtime-root 或默认 data/runner 决定）。 */
function lockOf(agentId) {
  return readLock(path.join(RUNTIME_ROOT, agentId));
}

function writeStatus(status, statusFile = STATUS_FILE) {
  try {
    fs.mkdirSync(path.dirname(statusFile), { recursive: true });
    fs.writeFileSync(statusFile, JSON.stringify(status, null, 2), 'utf8');
  } catch (error) {
    log(`状态落盘失败：${error.message}`);
  }
}

async function heartbeat(state, note, board = BOARD) {
  try {
    await call(
      '/api/heartbeat',
      {
        method: 'POST',
        body: JSON.stringify({ agent: SENTINEL_ID, state, note, source: 'sentinel' }),
      },
      board,
    );
  } catch {
    /* 黑板不可用时静默重试 */
  }
}

/** 只在「成员 + 结论 + 小时桶」变化时发言：巡检报告不该变成刷屏。 */
function shouldNotify(status, finding, nowMs) {
  const bucket = new Date(nowMs).toISOString().slice(0, 13); // 每小时一个桶
  const key = `${finding.member}:${finding.code}`;
  const seen = (status.notified && status.notified[key]) || null;
  if (!seen) return true;
  if (seen.bucket !== bucket) return true;
  if (seen.severity !== finding.severity) return true;
  return false;
}

function noticingText(finding, takeover) {
  const head = `【哨兵】${finding.member}：${finding.title}`;
  const action = takeover
    ? takeover.ok
      ? '已按托管清单拉起它的可托管通道（若你另有外部客户端在接管它，这一条就是重复来源：可以关掉 --no-takeover，或从清单里移除它）。'
      : `未拉起托管通道：${takeover.reason}。`
    : '没有对应的托管配置，因此只能报告——请在托管清单（desktop/watchdog-members.json）里为它补一条，才可能被自动接管。';
  return [
    `结论：${head}。`,
    `依据：${finding.detail}`,
    `下一步：${action} （本条由哨兵自动发出，kind=notice，不计作任何点名的实质回应。）`,
  ].join('\n');
}

async function postNotice(finding, takeover, pendingSeqs, { board = BOARD, dryRun = DRY_RUN } = {}) {
  if (dryRun) {
    log(`（dry-run）本该发言：${finding.member} ${finding.title}`);
    return null;
  }
  try {
    const posted = await call(
      '/api/message',
      {
        method: 'POST',
        body: JSON.stringify({
          agent: SENTINEL_ID,
          name: SENTINEL_IDENTITY.name,
          kind: 'notice',
          status: '待确认',
          topic: '哨兵巡检',
          text: noticingText(finding, takeover),
          // 幂等键按小时分桶：重复巡检不会在黑板上刷出第二条同样的话
          idempotencyKey: `sentinel:${finding.member}:${finding.code}:${new Date().toISOString().slice(0, 13)}`,
          client: {
            sentinel: true,
            code: finding.code,
            severity: finding.severity,
            ageMinutes: finding.ageMinutes || null,
            seqs: pendingSeqs || finding.seqs || null,
          },
        }),
      },
      board,
    );
    log(`已就 #${(finding.seqs || []).join(', #')} 在黑板发言：${finding.member} ${finding.title}`);
    return posted.message;
  } catch (error) {
    log(`发言失败（不影响接管）：${error.message}`);
    return null;
  }
}

function startManaged(member, start, { dryRun = DRY_RUN } = {}) {
  if (dryRun) {
    log(`（dry-run）本该拉起 ${member}：${start.join(' ')}`);
    return false;
  }
  const [exe, ...rest] = start;
  try {
    const child = spawn(exe, rest, { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    log(`已按托管清单拉起 ${member}：${start.join(' ')}`);
    return true;
  } catch (error) {
    log(`拉起 ${member} 失败：${error.message}`);
    return false;
  }
}

/* ── 一轮巡检 ────────────────────────────────────────────── */

export async function runRound(options = {}) {
  const {
    nowMs = Date.now(),
    status = null,
    board = BOARD,
    statusFile = STATUS_FILE,
    silentMinutes = SILENT_MINUTES,
    cooldownMinutes = COOLDOWN_MINUTES,
    takeover = TAKEOVER,
    dryRun = DRY_RUN,
    members = null,
  } = options;
  const previous = status || readJson(statusFile, {}) || {};
  let state;
  try {
    state = await call('/api/state?limit=1', {}, board);
  } catch (error) {
    const boardFinding = {
      code: 'BOARD_UNREACHABLE',
      severity: 'alert',
      member: '(board)',
      title: '黑板不可达',
      detail: `巡检拿不到 ${board}/api/state：${error.message}。成员是否在线、有没有人回话都无从判断。`,
    };
    const next = {
      ...previous,
      at: new Date(nowMs).toISOString(),
      board,
      reachable: false,
      totals: { alert: 1, warn: 0, info: 0 },
      findings: [boardFinding],
      notified: previous.notified || {},
      takeovers: previous.takeovers || {},
    };
    log(`黑板不可达：${error.message}`);
    if (!options.skipWrite) writeStatus(next, statusFile);
    return { status: next, findings: [boardFinding] };
  }

  const { findings, totals } = classifyBoard(state, { nowMs, silentMinutes });
  await heartbeat('online', `巡检中（每 ${INTERVAL_SECONDS}s 一轮）`, board);

  const notified = { ...(previous.notified || {}) };
  const takeovers = { ...(previous.takeovers || {}) };
  const acted = [];

  const managed = members || readMembers();
  const plans = takeover
    ? planTakeovers(findings, managed, { status: previous, nowMs, cooldownMinutes, lockOf: options.lockOf || lockOf })
    : [];
  const planById = new Map(plans.map((item) => [item.member, item]));

  for (const finding of findings) {
    if (finding.severity === 'info') continue;
    // 「接管」与「发言」是两件事：发言要按小时去重（不刷屏），
    // 接管只看条件与冷却——否则一个成员沉默很久时，接管会被去重逻辑一起挡住。
    let plan = planById.get(finding.member) || null;
    let startedNow = false;
    if (plan && plan.ok) {
      startedNow = startManaged(finding.member, plan.start, { dryRun });
      if (startedNow) takeovers[finding.member] = new Date(nowMs).toISOString();
      plan = { ...plan, ok: startedNow, reason: startedNow ? plan.reason : '启动失败（见 sentinel.log）' };
    }
    const fresh = shouldNotify({ notified }, finding, nowMs);
    if (!fresh && !startedNow) continue;
    const posted = await postNotice(finding, plan, finding.seqs, { board, dryRun });
    notified[`${finding.member}:${finding.code}`] = {
      at: new Date(nowMs).toISOString(),
      bucket: new Date(nowMs).toISOString().slice(0, 13),
      severity: finding.severity,
      seq: posted ? posted.seq : null,
    };
    acted.push({ ...finding, takeover: plan || null, seq: posted ? posted.seq : null });
  }

  const next = {
    at: new Date(nowMs).toISOString(),
    board,
    reachable: true,
    round: (previous.round || 0) + 1,
    thresholds: { silentMinutes, cooldownMinutes, intervalSeconds: INTERVAL_SECONDS },
    totals,
    members: (state.agents || []).map((agent) => ({
      id: agent.id,
      state: agent.state,
      engine: agent.engine || '',
      pending: agent.pending || 0,
      expired: (agent.deliveryCounts && agent.deliveryCounts.expired) || 0,
    })),
    findings,
    taken: acted.filter((item) => item.takeover && item.takeover.ok).map((item) => item.member),
    notified,
    takeovers,
  };
  if (!options.skipWrite) writeStatus(next, statusFile);

  const summary = `巡检：成员 ${next.members.length}，沉默 ${findings.filter((f) => f.code === 'SILENT_WITH_PENDING').length}，alert ${totals.alert || 0}，warn ${totals.warn || 0}，info ${totals.info || 0}`;
  log(summary);
  for (const finding of findings) {
    if (finding.severity === 'info') continue;
    log(`· [${finding.severity}] ${finding.member} — ${finding.title}：${finding.detail}`);
  }
  return { status: next, findings, acted };
}

async function main() {
  const started = `哨兵启动：board=${BOARD} 间隔=${INTERVAL_SECONDS}s 沉默阈值=${SILENT_MINUTES}分钟 接管=${TAKEOVER ? '开' : '关'}${DRY_RUN ? '（dry-run）' : ''}`;
  log(started);
  if (ONCE) {
    const { status, findings } = await runRound();
    if (AS_JSON) console.log(JSON.stringify({ ok: true, ...status, findings }, null, 2));
    if (FAIL_ON_ALERT && (status.totals.alert || 0) > 0) process.exitCode = 1;
    return;
  }
  for (;;) {
    try {
      await runRound();
    } catch (error) {
      log(`巡检异常：${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_SECONDS * 1000));
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`哨兵失败：${error.message}`);
    process.exitCode = 1;
  });
}
