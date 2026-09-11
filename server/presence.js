// Message Board · 在线状态（心跳）
//
// 纪律：**静态握手不等于在线** —— 只有新鲜的心跳才算在线。
//
//   data/heartbeat/<agent-id>.json   { schema, agent, state, last_seen, note, session }
//
// 判定：
//   age ≤ ttl            → 成员自报状态（online / busy / idle）
//   ttl < age ≤ ttl×倍率 → stale（最近出现过，但已超时）
//   更久或从未出现        → offline
//
// 成员是动态的（接入即登记），所以名册由 agentsProvider 每次实时提供。
// 心跳文件原子写入（先 .tmp 再重命名），与旧协议 aitc.filechannel.v1 写法一致。

import fs from 'node:fs';
import path from 'node:path';

import { SCHEMA, PRESENCE_STATES, localIso } from './protocol.js';

export class Presence {
  constructor({ agentsProvider, dir, ttlSeconds = 45, staleMultiplier = 6, sweepSeconds = 5, now = () => Date.now() }) {
    this.agentsProvider = agentsProvider;
    this.dir = dir;
    this.ttlSeconds = ttlSeconds;
    this.staleMultiplier = staleMultiplier;
    this.sweepSeconds = sweepSeconds;
    this.now = now;
    this.records = new Map();
    this.listeners = new Set();
    this.timer = null;
    this.lastSignature = '';
    fs.mkdirSync(dir, { recursive: true });
    this.#load();
  }

  #load() {
    let files = [];
    try {
      files = fs.readdirSync(this.dir).filter((name) => name.endsWith('.json'));
    } catch {
      return;
    }
    for (const name of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
        const agentId = String(raw.agent || path.basename(name, '.json')).toLowerCase();
        const at = Date.parse(raw.last_seen);
        this.records.set(agentId, {
          id: agentId,
          declared: raw.state || 'online',
          lastSeen: raw.last_seen || null,
          lastSeenAt: Number.isFinite(at) ? at : null,
          note: raw.note || '',
          session: raw.session || null,
          beats: 0,
        });
      } catch {
        /* 心跳文件损坏：按从未出现过处理 */
      }
    }
  }

  #fileFor(agentId) {
    return path.join(this.dir, `${agentId}.json`);
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  #writeAtomic(file, content) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, file);
  }

  /** 记录一次心跳。source 区分"显式心跳"与"发言/加入时的顺带刷新"。 */
  beat(agentId, { state, note = '', session = null, source = 'heartbeat' } = {}) {
    const id = String(agentId).toLowerCase();
    const declared = PRESENCE_STATES.includes(state) ? state : 'online';
    const at = this.now();
    const previous = this.records.get(id);
    // 只把**显式心跳**计入间隔样本：发言、加入也会刷新 last_seen，
    // 混进来会把"心跳频率"算成 1 秒这种假读数。
    const beatTimes = source === 'heartbeat'
      ? [...(previous?.beatTimes || []), at].slice(-10)
      : (previous?.beatTimes || []);
    const record = {
      id,
      declared,
      lastSeen: localIso(new Date(at)),
      lastSeenAt: at,
      note: String(note || '').slice(0, 200),
      session: session ? String(session).slice(0, 120) : null,
      beats: (previous?.beats || 0) + 1,
      heartbeats: (previous?.heartbeats || 0) + (source === 'heartbeat' ? 1 : 0),
      beatTimes,
    };
    this.records.set(id, record);
    try {
      this.#writeAtomic(
        this.#fileFor(id),
        JSON.stringify(
          { schema: SCHEMA, agent: id, state: declared, last_seen: record.lastSeen, note: record.note, session: record.session },
          null,
          0,
        ),
      );
    } catch {
      /* 心跳落盘失败不影响内存状态 */
    }
    this.#notifyIfChanged();
    return record;
  }

  resolveState(record) {
    if (!record || !record.lastSeenAt) return 'offline';
    const ageSeconds = (this.now() - record.lastSeenAt) / 1000;
    if (ageSeconds <= this.ttlSeconds) return record.declared;
    if (ageSeconds <= this.ttlSeconds * this.staleMultiplier) return 'stale';
    return 'offline';
  }

  /**
   * 实测心跳间隔（秒）：取最近几次心跳间隔的中位数，避免单次抖动。
   * 来源是服务端观测到的**显式心跳**时刻，不是成员自述的周期；
   * 小于 2 秒的间隔视为并发刷新，忽略，否则会把读数拉成 1 秒这种假值。
   */
  heartbeatIntervalSeconds(record) {
    const times = record?.beatTimes || [];
    if (times.length < 2) return null;
    const deltas = [];
    for (let i = 1; i < times.length; i += 1) {
      const delta = (times[i] - times[i - 1]) / 1000;
      if (delta >= 2) deltas.push(delta);
    }
    if (!deltas.length) return null;
    deltas.sort((a, b) => a - b);
    const mid = Math.floor(deltas.length / 2);
    const median = deltas.length % 2 ? deltas[mid] : (deltas[mid - 1] + deltas[mid]) / 2;
    return Math.max(1, Math.round(median));
  }

  /** 名册快照（含隐藏成员；对外过滤由调用方负责）。 */
  snapshot() {
    return this.agentsProvider().map((agent) => {
      const record = this.records.get(agent.id) || null;
      const ageSeconds = record && record.lastSeenAt ? Math.round((this.now() - record.lastSeenAt) / 1000) : null;
      return {
        id: agent.id,
        name: agent.name,
        monogram: agent.monogram,
        title: agent.title,
        platform: agent.platform,
        channel: agent.channel,
        kind: agent.kind,
        hidden: agent.hidden,
        selfDeclared: agent.selfDeclared,
        joinedAt: agent.joinedAt,
        state: this.resolveState(record),
        declared: record ? record.declared : null,
        lastSeen: record ? record.lastSeen : null,
        ageSeconds,
        heartbeatIntervalSeconds: this.heartbeatIntervalSeconds(record),
        beats: record ? record.beats : 0,
        heartbeats: record ? record.heartbeats || 0 : 0,
        note: record ? record.note : '',
        everSeen: Boolean(record && record.lastSeenAt),
      };
    });
  }

  /** 只统计会显示在侧栏里的成员。 */
  summary() {
    const visible = this.snapshot().filter((item) => !item.hidden);
    return {
      ttlSeconds: this.ttlSeconds,
      staleAfterSeconds: this.ttlSeconds * this.staleMultiplier,
      online: visible.filter((item) => item.state === 'online' || item.state === 'busy').length,
      total: visible.length,
    };
  }

  /**
   * 变更签名：必须包含**界面上会显示的东西**。
   * 早先只比 `id:state`，于是"状态没变但 lastSeen/note/心跳间隔变了"的心跳不会通知订阅者，
   * 面板上的「上次心跳 X 秒前」「心跳 ~25s」只能等 30 秒轮询——这就是"成员状态不同步"的根因。
   * ageSeconds 按 15 秒分桶，避免每几秒就推一次无意义刷新。
   */
  #signature() {
    return this.snapshot()
      .map((item) =>
        [
          item.id,
          item.state,
          item.declared,
          item.note,
          item.heartbeatIntervalSeconds,
          Math.floor((item.ageSeconds ?? 0) / 15),
        ].join(':'),
      )
      .join('|');
  }

  #notifyIfChanged() {
    const signature = this.#signature();
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot());
      } catch {
        /* 订阅者异常不影响心跳 */
      }
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.#notifyIfChanged(), Math.max(1, this.sweepSeconds) * 1000);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
