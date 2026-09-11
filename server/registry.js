// Message Board · 成员登记表（接入即登记）
//
// 与旧版「预置名册」的区别：成员不再需要在 board.config.json 里预先写好。
// 任何 AI 调用 POST /api/join 自述身份即成为正式成员；只发心跳或直接发言的，
// 也会被登记为最小身份（name = id），避免出现「说不了话也上不了板」的死角。
//
// 落盘：data/agents.json（原子写入），顺序即侧栏显示顺序 —— 新成员向下排列。
//
// 另外有一个不出现在成员列表里的「本地操作员」，只用于本机黑板输入框留言。

import fs from 'node:fs';
import path from 'node:path';

import { SCHEMA, stripBom } from './protocol.js';

const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

function monogramOf(name, id) {
  const source = String(name || id || '?').trim();
  const ascii = source.match(/[A-Za-z0-9]/);
  return (ascii ? ascii[0] : source.charAt(0)).toUpperCase();
}

function tidy(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 头像：只接受站点内路径或 http(s) 地址。 */
function normalizeAvatar(value) {
  const url = String(value || '').trim().slice(0, 300);
  if (!url) return '';
  if (url.startsWith('/') || /^https?:\/\//i.test(url)) return url;
  return '';
}

/** 成员的唤醒方式：只认成员自己声明的回调地址，或运维配置的本机命令。 */
function normalizeWake(wake, callback) {
  const raw = wake && typeof wake === 'object' ? wake : {};
  const url = String(raw.url || callback || '').trim();
  if ((raw.type === 'callback' || url) && /^https?:\/\//i.test(url)) {
    return { type: 'callback', url: url.slice(0, 300) };
  }
  if (raw.type === 'inbox') return { type: 'inbox' };
  return null;
}

export class Registry {
  /**
   * @param {{ file: string, presets?: object[], localOperator?: object|null }} options
   */
  constructor({ file, presets = [], localOperator = null }) {
    this.file = file;
    this.presets = presets.map((agent) => this.#normalize(agent, { source: 'preset' }));
    this.localOperator = localOperator ? this.#normalize({ ...localOperator, hidden: true }, { source: 'preset' }) : null;
    this.dynamic = new Map();
    this.order = [];
    this.#load();
  }

  #normalize(agent, { source }) {
    const id = String(agent.id || '').toLowerCase();
    const name = tidy(agent.name, 40) || id;
    return {
      id,
      name,
      monogram: tidy(agent.monogram, 2) || monogramOf(name, id),
      platform: tidy(agent.platform, 40),
      title: tidy(agent.title, 40),
      mission: tidy(agent.mission, 200),
      skills: tidy(agent.skills, 200),
      constraints: tidy(agent.constraints, 200),
      channel: ['http', 'file', 'desktop'].includes(agent.channel) ? agent.channel : 'http',
      kind: agent.kind === 'operator' ? 'operator' : 'ai',
      // 回应形态：autonomous = 被 @ 后能自己产出实质回复；
      // manual = 需要人类去唤起它的对话（例如只能人工交互的网页版）。
      // 接入方必须如实声明——manual 成员的点名会被标成「待人工唤起」，而不是记它超时。
      respondMode: agent.respondMode === 'manual' ? 'manual' : 'autonomous',
      hidden: Boolean(agent.hidden),
      avatar: normalizeAvatar(agent.avatar),
      wake: normalizeWake(agent.wake, agent.callback),
      // 本机唤醒命令只能由运维写在 board.config.json 里，绝不接受接入方自报
      wakeCommand: source === 'preset' ? tidy(agent.wakeCommand, 300) : '',
      joinedAt: agent.joinedAt || null,
      selfDeclared: Boolean(agent.selfDeclared),
      source,
    };
  }

  #load() {
    if (!fs.existsSync(this.file)) return;
    try {
      const raw = JSON.parse(stripBom(fs.readFileSync(this.file, 'utf8')));
      const list = Array.isArray(raw) ? raw : raw.agents;
      if (!Array.isArray(list)) return;
      for (const item of list) {
        if (!item || !AGENT_ID_RE.test(String(item.id || '').toLowerCase())) continue;
        const agent = this.#normalize(item, { source: 'dynamic' });
        this.dynamic.set(agent.id, agent);
        this.order.push(agent.id);
      }
    } catch {
      /* 登记表损坏时不阻断启动：保持空表，后续接入会重建 */
    }
  }

  #save() {
    const payload = {
      schema: SCHEMA,
      updatedAt: new Date().toISOString(),
      agents: this.order.map((id) => this.dynamic.get(id)).filter(Boolean),
    };
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  /** 成员 id 不区分大小写：归一化后再校验，避免 Codex 与 codex 变成两个成员。 */
  static normalizeId(id) {
    return String(id ?? '').trim().toLowerCase();
  }

  static isValidId(id) {
    return AGENT_ID_RE.test(Registry.normalizeId(id));
  }

  has(id) {
    const key = Registry.normalizeId(id);
    return this.dynamic.has(key) || this.presets.some((agent) => agent.id === key) ||
      (this.localOperator ? this.localOperator.id === key : false);
  }

  get(id) {
    const key = Registry.normalizeId(id);
    if (this.dynamic.has(key)) return this.dynamic.get(key);
    const preset = this.presets.find((agent) => agent.id === key);
    if (preset) return preset;
    if (this.localOperator && this.localOperator.id === key) return this.localOperator;
    return null;
  }

  /** 接入即登记：写入或更新成员身份。 */
  upsert(identityIn, { selfDeclared = true } = {}) {
    const id = Registry.normalizeId(identityIn.id || identityIn.agent);
    if (!AGENT_ID_RE.test(id)) {
      throw Object.assign(new Error('成员 id 只能是小写字母、数字、下划线或短横线（2–32 位）'), { code: 'BAD_AGENT_ID' });
    }
    const existing = this.dynamic.get(id);
    // 唤醒命令不接受自报：接入方只能声明自己的回调地址
    const { wakeCommand: _ignored, ...identity } = identityIn;
    const agent = this.#normalize(
      {
        ...(existing || {}),
        ...identity,
        id,
        // 自述为空的字段保留原值，避免一次接入把已有身份抹平
        name: identity.name || (existing && existing.name) || id,
        joinedAt: (existing && existing.joinedAt) || new Date().toISOString(),
      },
      { source: 'dynamic' },
    );
    agent.selfDeclared = selfDeclared || Boolean(existing && existing.selfDeclared);
    this.dynamic.set(id, agent);
    if (!this.order.includes(id)) this.order.push(id);
    this.#save();
    return agent;
  }

  /** 未登记成员的最小身份（只发心跳/直接发言时使用）。 */
  ensure(id) {
    const key = Registry.normalizeId(id);
    const existing = this.get(key);
    if (existing) return { agent: existing, created: false };
    const agent = this.upsert({ id: key, name: key, title: '未自述身份', platform: '未自述' }, { selfDeclared: false });
    return { agent, created: true };
  }

  /** 全部成员（含隐藏的本地操作员），按接入顺序。 */
  all() {
    const list = [];
    for (const id of this.order) {
      const agent = this.dynamic.get(id);
      if (agent) list.push(agent);
    }
    for (const preset of this.presets) {
      if (!list.some((agent) => agent.id === preset.id)) list.push(preset);
    }
    if (this.localOperator) list.push(this.localOperator);
    return list;
  }

  /** 名册（用于侧栏与在线状态）：隐藏成员不出现，顺序即接入顺序。 */
  visible() {
    return this.all().filter((agent) => !agent.hidden);
  }

  byId() {
    return new Map(this.all().map((agent) => [agent.id, agent]));
  }
}
