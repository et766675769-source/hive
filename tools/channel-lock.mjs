// Message Board · 托管通道的归属锁
//
// 「同一个成员被两个进程同时接管」是这套系统里最难查的一类故障：
// 面板显示在线、长轮询也挂着，可回复要么不来、要么来两条，而每个进程都觉得自己才是正主。
// 实测踩过：同一成员一个 `tools/mb.js watch` 挂心跳、一个 agent-runner 回答，
// 加上 watchdog 与哨兵各拉起一次，一次点名能刷出三条留言。
//
// 约定：一个成员的托管通道在 data/runner/<agent>/runner.lock 里写一份归属声明
//   { pid, agent, startedAt, beatAt }
// · 运行器启动时要先拿到锁：锁被一个**活着且没卡死**的进程持有 → 本进程礼貌退出；
// · 运行期间每 30 秒刷新 beatAt；
// · watchdog 与哨兵在拉起之前先看这把锁：有人正常持有就不要再拉一个。
//
// 「卡死」的判定是必须的：进程还在但 beatAt 很久没动（例如卡在一次网络等待里），
// 这时不允许接管，就等于让这个成员永久沉默。

import fs from 'node:fs';
import path from 'node:path';

export const STALE_MINUTES_DEFAULT = 5;

export function lockFileFor(runtimeDir) {
  return path.join(runtimeDir, 'runner.lock');
}

export function readLock(runtimeDir) {
  try {
    const text = fs.readFileSync(lockFileFor(runtimeDir), 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** 进程还活着吗（不能杀，只探测）。 */
export function pidAlive(pid) {
  const value = Number(pid);
  if (!Number.isFinite(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    // EPERM：进程存在但没权限——那也算活着
    return error && error.code === 'EPERM';
  }
}

/**
 * 纯函数：给定锁内容，判断该不该让出/接管。
 * @returns {{ holder: number|null, state: 'free'|'held'|'stale', reason: string }}
 */
export function evaluateLock(lock, { nowMs = Date.now(), isAlive = pidAlive, staleMinutes = STALE_MINUTES_DEFAULT } = {}) {
  if (!lock || !lock.pid) return { holder: null, state: 'free', reason: '没有锁文件（或内容不完整）' };
  if (!isAlive(lock.pid)) return { holder: null, state: 'free', reason: `锁里的进程 ${lock.pid} 已经不在了` };
  const beatAt = Date.parse(lock.beatAt || lock.startedAt || '') || 0;
  const ageMinutes = beatAt ? (nowMs - beatAt) / 60000 : Number.POSITIVE_INFINITY;
  if (ageMinutes >= staleMinutes) {
    return {
      holder: lock.pid,
      state: 'stale',
      reason: `进程 ${lock.pid} 还在，但已经 ${Math.round(ageMinutes)} 分钟没有心跳（阈值 ${staleMinutes} 分钟），按卡死处理`,
    };
  }
  return { holder: lock.pid, state: 'held', reason: `进程 ${lock.pid} 正常持有（活跃于 ${Math.round(ageMinutes)} 分钟前）` };
}

/**
 * 运行器启动时调用：拿到锁就返回一个可用的续约/释放句柄；锁被正常持有时返回 null（调用方应退出）。
 */
export function acquireLock(runtimeDir, { agent, now = () => Date.now(), isAlive = pidAlive, staleMinutes = STALE_MINUTES_DEFAULT } = {}) {
  fs.mkdirSync(runtimeDir, { recursive: true });
  const evaluation = evaluateLock(readLock(runtimeDir), { nowMs: now(), isAlive, staleMinutes });
  if (evaluation.state === 'held') return { held: true, ...evaluation };
  const write = (beatAt) => {
    const payload = { pid: process.pid, agent, startedAt: beatAt, beatAt };
    fs.writeFileSync(lockFileFor(runtimeDir), JSON.stringify(payload), 'utf8');
  };
  const startedAt = new Date(now()).toISOString();
  try {
    if (evaluation.state === 'stale' && evaluation.holder) {
      // 上一任还"活着"但已经不心跳了：记下来，方便事后查它到底卡在哪
      fs.appendFileSync(
        path.join(runtimeDir, 'lock-history.log'),
        `${new Date(now()).toISOString()} takeover from pid ${evaluation.holder}: ${evaluation.reason}\n`,
        'utf8',
      );
    }
    write(startedAt);
  } catch (error) {
    return { held: false, state: 'error', reason: `写锁失败：${error.message}` };
  }
  return {
    held: false,
    state: 'acquired',
    reason: evaluation.state === 'free' ? evaluation.reason : evaluation.reason,
    beat: () => {
      try {
        write(new Date(now()).toISOString());
      } catch {
        /* 续约失败由心跳日志体现，不阻断主循环 */
      }
    },
    release: () => {
      try {
        const current = readLock(runtimeDir);
        if (current && Number(current.pid) === process.pid) fs.rmSync(lockFileFor(runtimeDir), { force: true });
      } catch {
        /* 释放失败就让下一次启动按"卡死"接管 */
      }
    },
  };
}
