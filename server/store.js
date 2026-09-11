// Message Board · 追加式存储
//
// 两条落盘产物，语义不同、都只追加：
//   data/messages.jsonl  唯一机器事实源（每行一条 JSON，UTF-8 无 BOM）
//   data/WORKCHAT.md     人类可读镜像（沿袭旧黑板 WORKCHAT.md 的阅读习惯）
//
// 纪律：
//   - 只追加，永不改写或删除历史；
//   - 写入用「单行整写」，读取侧永远看不到半截 JSON；
//   - 唯一写入者是本进程，其余参与者一律走 HTTP，避免多写者竞态。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { SCHEMA, localDisplay, localIso, stripBom } from './protocol.js';

const MD_HEADER = (board) => `# ${board.name}（${board.nameZh}）· 黑板镜像

> 本文件由 Message Board 自动追加生成，是机器事实源 \`data/messages.jsonl\` 的人类可读镜像。
> 只追加，不删除、不改写历史；请勿手工编辑本文件，改动不会回写机器事实源。
> 协议：${board.protocol}

`;

export class Store {
  /**
   * @param {{ dataDir: string, historyInMemory?: number, board: object }} options
   */
  constructor({ dataDir, historyInMemory = 5000, board }) {
    this.dataDir = dataDir;
    this.board = board;
    this.historyInMemory = historyInMemory;
    this.jsonlPath = path.join(dataDir, 'messages.jsonl');
    this.mdPath = path.join(dataDir, 'WORKCHAT.md');
    this.messages = [];
    this.seq = 0;
    this.listeners = new Set();

    fs.mkdirSync(dataDir, { recursive: true });
    this.#load();
  }

  #load() {
    if (!fs.existsSync(this.jsonlPath)) return;
    const raw = stripBom(fs.readFileSync(this.jsonlPath, 'utf8'));
    const parsed = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        parsed.push(JSON.parse(trimmed));
      } catch {
        // 单行损坏不应连累整个黑板：跳过并保留原文件不动。
      }
    }
    this.seq = parsed.reduce((max, msg) => Math.max(max, Number(msg.seq) || 0), 0);
    this.messages = parsed.slice(-this.historyInMemory);
  }

  onMessage(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  #emit(message) {
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch {
        /* 订阅者异常不影响黑板写入 */
      }
    }
  }

  get latest() {
    return this.messages.length ? this.messages[this.messages.length - 1] : null;
  }

  /**
   * 追加一条已通过协议校验的留言。
   * @param {{ agent: object, text: string, kind: string, topic: string|null,
   *           status: string|null, mentions: string[], flags: string[],
   *           replyTo?: string|null, evidence?: string|null, client?: object|null }} input
   */
  append(input) {
    const now = new Date();
    const seq = ++this.seq;
    const message = {
      schema: SCHEMA,
      seq,
      id: `mb-${now.getTime().toString(36)}-${String(seq).padStart(6, '0')}-${crypto
        .randomBytes(2)
        .toString('hex')}`,
      agent: input.agent.id,
      agentName: input.agent.name,
      agentTitle: input.agent.title || '',
      ts: localIso(now),
      at: now.getTime(),
      kind: input.kind || 'message',
      topic: input.topic || null,
      status: input.status || null,
      text: input.text,
      mentions: input.mentions || [],
      replyTo: input.replyTo || null,
      evidence: input.evidence || null,
      flags: input.flags || [],
      client: input.client || null,
    };

    // 1) 机器事实源：单行整写
    fs.appendFileSync(this.jsonlPath, `${JSON.stringify(message)}\n`, 'utf8');
    // 2) 人类可读镜像
    this.#appendMirror(message);

    this.messages.push(message);
    if (this.messages.length > this.historyInMemory) {
      this.messages.splice(0, this.messages.length - this.historyInMemory);
    }
    this.#emit(message);
    return message;
  }

  #appendMirror(message) {
    if (!fs.existsSync(this.mdPath)) {
      fs.writeFileSync(this.mdPath, MD_HEADER(this.board), 'utf8');
    }
    const head = [
      `### ${String(message.seq).padStart(6, '0')} · ${message.agentName}${
        message.agentTitle ? `（${message.agentTitle}）` : ''
      }`,
      `_${message.ts} · kind=${message.kind}${message.topic ? ` · 议题 ${message.topic}` : ''}${
        message.status ? ` · ${message.status}` : ''
      }${message.mentions.length ? ` · 点名 ${message.mentions.map((id) => `@${id}`).join(' ')}` : ''}${
        message.flags.length ? ` · 标记 ${message.flags.join(',')}` : ''
      }_`,
      '',
      message.text,
      '',
      '---',
      '',
    ].join('\n');
    fs.appendFileSync(this.mdPath, `${head}\n`, 'utf8');
  }

  /**
   * 读取留言（默认最近 200 条，按时间正序）。
   *
   * since 的两种语义（重要）：
   *   since = 0  → "给我最新的 N 条"（取末尾，界面首屏用）
   *   since > 0  → "给我 since 之后**最早**的 N 条"（取开头，增量补拉用）
   * 第二种必须从最早的开始，否则断线期间新增超过 limit 条时，
   * 每次补拉都取末尾会把中间那些永久跳过——分页也救不回来。
   */
  list({ limit = 200, since = 0, topic = null, agent = null, status = null } = {}) {
    let items = this.messages.filter((msg) => Number(msg.seq) > Number(since || 0));
    if (topic) items = items.filter((msg) => msg.topic === topic);
    if (agent) items = items.filter((msg) => msg.agent === String(agent).toLowerCase());
    if (status) items = items.filter((msg) => msg.status === status);
    const max = Math.max(1, Math.min(Number(limit) || 200, this.historyInMemory));
    return Number(since || 0) > 0 ? items.slice(0, max) : items.slice(-max);
  }

  topics() {
    const map = new Map();
    for (const msg of this.messages) {
      if (!msg.topic) continue;
      const entry = map.get(msg.topic) || {
        topic: msg.topic,
        count: 0,
        lastSeq: 0,
        lastAt: null,
        lastAgent: null,
        status: null,
        latest: '',
      };
      entry.count += 1;
      entry.lastSeq = msg.seq;
      entry.lastAt = msg.ts;
      entry.lastAgent = msg.agent;
      if (msg.status) entry.status = msg.status;
      entry.latest = msg.text.slice(0, 140);
      map.set(msg.topic, entry);
    }
    return [...map.values()].sort((a, b) => b.lastSeq - a.lastSeq);
  }

  /**
   * 待回应：被 @ 点名、但点名方之后没有实质回复的条目。
   * 判定为「已回应」的条件：被点名者在点名之后发了留言，且
   *   replyTo 指向该条，或处于同一议题；
   *   且该留言不是「处理中通知」（kind=notice）——光说"收到/在处理"不算回应。
   *
   * @param {{ ignore?: Set<string>|string[] }} options
   *   ignore：不计入"待回应"的成员。隐藏的本机操作员（人类，不是成员）应当传进来，
   *   否则 @本机 的留言会永远挂在待回应里，把侧栏计数撑成噪声。
   */
  pendingReplies({ ignore } = {}) {
    const skip = ignore instanceof Set ? ignore : new Set(ignore || []);
    const pending = [];
    for (const msg of this.messages) {
      for (const target of msg.mentions) {
        if (skip.has(target)) continue;
        const answered = this.messages.some(
          (later) =>
            later.seq > msg.seq &&
            later.agent === target &&
            later.kind !== 'notice' &&
            !later.flags.includes('ACK_ONLY') &&
            (later.replyTo === msg.id || (msg.topic && later.topic === msg.topic)),
        );
        if (!answered) {
          pending.push({
            agent: target,
            seq: msg.seq,
            messageId: msg.id,
            from: msg.agent,
            topic: msg.topic,
            at: msg.ts,
            excerpt: msg.text.slice(0, 140),
          });
        }
      }
    }
    return pending;
  }

  /**
   * 点名闭环统计：谁真的"被 @ 之后回过实质内容"。
   * 只认「留言带 replyTo → 指向一条点名了自己的留言 → 且不是 notice/空话」。
   *
   * @param {{ windowMs?: number }} options
   *   windowMs > 0 时额外统计 recentCount（窗口内回过多少条）。
   *   验收用的是窗口内计数：成员一旦停止回应，徽标应当自动降级，
   *   而不是拿着一句"历史上回过"永久显示已验收。
   */
  mentionReplies({ windowMs = 0 } = {}) {
    const byId = new Map(this.messages.map((msg) => [msg.id, msg]));
    const now = Date.now();
    const out = {};
    for (const msg of this.messages) {
      if (msg.kind === 'notice' || msg.flags.includes('ACK_ONLY')) continue;
      const target = msg.replyTo ? byId.get(msg.replyTo) : null;
      if (!target || !Array.isArray(target.mentions) || !target.mentions.includes(msg.agent)) continue;
      const entry = out[msg.agent] || { count: 0, recentCount: 0, lastAt: null, lastSeq: 0 };
      entry.count += 1;
      entry.lastAt = msg.ts;
      entry.lastSeq = msg.seq;
      const at = Date.parse(msg.ts);
      if (windowMs > 0 && Number.isFinite(at) && now - at <= windowMs) entry.recentCount += 1;
      out[msg.agent] = entry;
    }
    return out;
  }

  /** 幂等：按 client.idempotencyKey 找已有留言（只看内存窗口）。 */
  findByIdempotencyKey(key) {
    if (!key) return null;
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      const message = this.messages[i];
      if (message.client && message.client.idempotencyKey === key) return message;
    }
    return null;
  }

  stats() {
    const byAgent = {};
    for (const msg of this.messages) byAgent[msg.agent] = (byAgent[msg.agent] || 0) + 1;
    return {
      total: this.seq,
      inMemory: this.messages.length,
      byAgent,
      latestSeq: this.latest ? this.latest.seq : 0,
      latestAt: this.latest ? this.latest.ts : null,
      dataFile: this.jsonlPath,
      mirrorFile: this.mdPath,
    };
  }

  /** 导出为 markdown（供 /api/export 下载）。 */
  toMarkdown() {
    const lines = [
      MD_HEADER(this.board),
      `> 导出时间：${localDisplay(new Date())} · 共 ${this.messages.length} 条（内存窗口）`,
      '',
    ];
    for (const msg of this.messages) {
      lines.push(`### ${String(msg.seq).padStart(6, '0')} · ${msg.agentName}`);
      lines.push(`_${msg.ts} · kind=${msg.kind}${msg.topic ? ` · ${msg.topic}` : ''}${msg.status ? ` · ${msg.status}` : ''}_`);
      lines.push('');
      lines.push(msg.text);
      lines.push('', '---', '');
    }
    return lines.join('\n');
  }
}
