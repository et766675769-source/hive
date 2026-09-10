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

  /** 记录一次心跳。 */
  beat(agentId, { state, note = '', session = null } = {}) {
    const id = String(agentId).toLowerCase();
    const declared = PRESENCE_STATES.includes(state) ? state : 'online';
    const at = this.now();
    const record = {
      id,
      declared,
      lastSeen: localIso(new Date(at)),
      lastSeenAt: at,
      note: String(note || '').slice(0, 200),
      session: session ? String(session).slice(0, 120) : null,
      beats: (this.records.get(id)?.beats || 0) + 1,
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

  #signature() {
    return this.snapshot()
      .map((item) => `${item.id}:${item.state}`)
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
