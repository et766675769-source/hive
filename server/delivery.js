// Message Board · 投递台账（delivery ledger）
//
// 把「点名 → 回应」变成一条**有状态、可观测、可回收**的投递记录，而不是只看有没有回复：
//
//   queued     已产生点名，但还没送出去（当时没有可用通道）
//   delivered  已送达某个通道（长轮询 / 回调 / 本机命令）——对方至少收到了
//   working    对方声明"正在处理"（它发了 kind=notice 且 replyTo 指向该条）
//   replied    对方给出了实质回复（kind != notice 且 replyTo 指向该条）——终态
//   expired    租约到期仍无实质回复；若还有重试次数，会自动回到 queued 重投
//
// 纪律：
//   - 只追加：每次状态变化写一行到 data/deliveries.jsonl，内存里是它的投影；进程重启可完整重建；
//   - 幂等：以 messageId + agent 为键，重复投递不会产生第二条记录；
//   - 租约：送达/处理中各有一个 deadline，到期由 sweep() 判定过期；最多重投 maxAttempts 次，不做无限循环。

import fs from 'node:fs';
import path from 'node:path';

import { stripBom } from './protocol.js';

export const DELIVERY_STATES = ['queued', 'delivered', 'working', 'replied', 'expired'];
const TERMINAL = new Set(['replied']);

export class DeliveryLedger {
  /**
   * @param {{ file: string, leaseSeconds?: number, maxAttempts?: number, maxRenewals?: number, now?: () => number }} options
   */
  constructor({ file, leaseSeconds = 180, maxAttempts = 2, maxRenewals = 5, ackTimeoutSeconds = 45, now = () => Date.now() }) {
    this.file = file;
    this.leaseSeconds = leaseSeconds;
    this.maxAttempts = maxAttempts;
    this.maxRenewals = maxRenewals;
    this.ackTimeoutSeconds = ackTimeoutSeconds;
    this.now = now;
    this.records = new Map(); // key → record
    this.order = []; // key 的创建顺序（用于稳定输出）
    this.#load();
  }

  static keyOf(messageId, agent) {
    return `${messageId}|${agent}`;
  }

  #load() {
    if (!fs.existsSync(this.file)) return;
    let lines = [];
    try {
      lines = stripBom(fs.readFileSync(this.file, 'utf8')).split('\n');
    } catch {
      return;
    }
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }
      this.#apply(entry, { persist: false });
    }
  }

  #persist(entry) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      /* 台账落盘失败不影响主流程，内存投影仍可用 */
    }
  }

  /** 把一条事件应用到内存投影。 */
  #apply(entry, { persist = true } = {}) {
    const key = DeliveryLedger.keyOf(entry.messageId, entry.agent);
    const existing = this.records.get(key);
    const record = existing || {
      messageId: entry.messageId,
      agent: entry.agent,
      seq: entry.seq ?? null,
      topic: entry.topic ?? null,
      state: 'queued',
      channel: null,
      attempts: 0,
      createdAt: entry.at || this.now(),
      updatedAt: entry.at || this.now(),
      deadlineAt: null,
      ackDeadlineAt: null,
      note: '',
      renewals: 0,
      history: [],
    };

    if (entry.state) record.state = entry.state;
    if (entry.channel !== undefined) record.channel = entry.channel;
    if (entry.note !== undefined) record.note = entry.note || '';
    if (entry.seq != null) record.seq = entry.seq;
    if (entry.topic !== undefined) record.topic = entry.topic;
    if (entry.attempts != null) record.attempts = entry.attempts;
    else if (entry.state === 'delivered') record.attempts += 1;
    if (entry.renewals != null) record.renewals = entry.renewals;
    if (entry.endedBy !== undefined) record.endedBy = entry.endedBy;
    if (entry.ackDeadlineAt !== undefined) record.ackDeadlineAt = entry.ackDeadlineAt;
    if (entry.deadlineAt !== undefined) record.deadlineAt = entry.deadlineAt;
    record.updatedAt = entry.at || this.now();

    record.history.push({ at: record.updatedAt, state: record.state, channel: record.channel, note: record.note });
    if (record.history.length > 6) record.history.shift();

    if (!existing) {
      this.records.set(key, record);
      this.order.push(key);
    }
    if (persist) this.#persist({ ...entry, at: record.updatedAt });
    return record;
  }

  #set(messageId, agent, state, { channel, note, deadlineAt, attempts, seq, topic, renewals, ackDeadlineAt, endedBy } = {}) {
    if (!DELIVERY_STATES.includes(state)) throw new Error(`未知投递状态：${state}`);
    const at = this.now();
    return this.#apply({ messageId, agent, state, channel, note, deadlineAt, attempts, seq, topic, renewals, ackDeadlineAt, endedBy, at });
  }

  /** 为一条带点名的留言建立投递记录（幂等：已存在就返回原记录）。 */
  ensure(message, agents) {
    const created = [];
    for (const agent of agents) {
      const key = DeliveryLedger.keyOf(message.id, agent);
      if (this.records.has(key)) continue;
      created.push(
        this.#set(message.id, agent, 'queued', {
          note: '点名已产生，等待投递',
          seq: message.seq,
          topic: message.topic || null,
          deadlineAt: null,
        }),
      );
    }
    return created;
  }

  /**
   * 投递结果回填。
   * 注意：channel=queued 表示"没人接，先进队列"——那是**没送到**，状态保持 queued，
   * 不能算 delivered，否则界面上会把"没人听"显示成"已送达"。
   */
  markDelivered(messageId, agent, { channel, ok, error } = {}) {
    const reachedSomeone = Boolean(ok) && Boolean(channel) && channel !== 'queued';
    if (!reachedSomeone) {
      return this.#set(messageId, agent, 'queued', {
        channel: channel || null,
        note: error
          ? `投递失败：${error}`
          : channel === 'queued'
            ? '暂无可用通道，已入队等对方取走'
            : '尚未投递',
        deadlineAt: null,
      });
    }
    return this.#set(messageId, agent, 'delivered', {
      channel,
      note: `已送达（${channel}）`,
      deadlineAt: this.now() + this.leaseSeconds * 1000,
      // 确认超时：送达后成员应当很快回一条「处理中」；
      // 如果连确认都没有，多半是信封被投给了已经死掉的连接——不必等满租约。
      ackDeadlineAt: this.now() + this.ackTimeoutSeconds * 1000,
    });
  }

  /** 对方回了「处理中」通知 → working（同时把租约续上）。 */
  markWorking(message) {
    if (!message.replyTo) return null;
    const key = DeliveryLedger.keyOf(message.replyTo, message.agent);
    if (!this.records.has(key)) return null;
    return this.#set(message.replyTo, message.agent, 'working', {
      note: '对方已开始处理',
      deadlineAt: this.now() + this.leaseSeconds * 1000,
    });
  }

  /** 对方回了实质内容 → replied（终态）。 */
  markReplied(message) {
    if (!message.replyTo) return null;
    const key = DeliveryLedger.keyOf(message.replyTo, message.agent);
    if (!this.records.has(key)) return null;
    return this.#set(message.replyTo, message.agent, 'replied', {
      note: '已收到实质回复',
      deadlineAt: null,
    });
  }

  /**
   * 人类主动打断 → 直接判定终结（expired），**不再回收重投**。
   * 这是"被叫停"，不是"没回"：如果按超时处理，租约一到就会自动重投，等于把打断的任务又复活。
   */
  markInterrupted(message) {
    if (!message.replyTo) return null;
    const key = DeliveryLedger.keyOf(message.replyTo, message.agent);
    if (!this.records.has(key)) return null;
    return this.#set(message.replyTo, message.agent, 'expired', {
      note: '已被人类打断，按终结处理（不再重投）',
      deadlineAt: null,
      // 和"超时未回"分开记：这是人类主动叫停，不是成员没回应
      endedBy: 'interrupted',
    });
  }

  /**
   * 服务重启恢复：把台账从重启前残留的 delivered/working **拉回 queued**。
   * 否则会出现"唤醒队列里有这条、台账却还写着 working"的不一致——
   * 面板显示与真实投递状态对不上，正是用户说的"重启后像卡住"。
   */
  markRecoveredQueued(messageId, agent) {
    const key = DeliveryLedger.keyOf(messageId, agent);
    if (!this.records.has(key)) return null;
    return this.#set(messageId, agent, 'queued', {
      note: '服务重启后恢复，已重新入队投递',
      deadlineAt: null,
      renewals: 0,
    });
  }

  /**
   * 重启恢复时超出 backfillLimit、本轮不自动重投的条目：
   * 必须留一条**可见**记录（expired + 说明），而不是静默忽略。
   */
  markRecoveryDeferred(messageId, agent) {
    const key = DeliveryLedger.keyOf(messageId, agent);
    if (!this.records.has(key)) return null;
    return this.#set(messageId, agent, 'expired', {
      note: '服务重启恢复时超出重投上限，已登记为未自动重投（可手动重发点名）',
      deadlineAt: null,
      endedBy: 'deferred',
    });
  }

  /** 某条留言的全部投递记录。 */
  forMessage(messageId) {
    return this.order
      .map((key) => this.records.get(key))
      .filter((record) => record && record.messageId === messageId)
      .map((record) => this.#view(record));
  }

  /**
   * 该成员**未完成**的投递（queued / delivered / working），按序号从早到晚。
   * 契约状态（server/contract.js）与哨兵都从这里取事实：一个成员当前卡在哪一步。
   */
  openForAgent(agent) {
    return this.order
      .map((key) => this.records.get(key))
      .filter((record) => record && record.agent === agent && !TERMINAL.has(record.state) && record.state !== 'expired')
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
      .map((record) => this.#view(record));
  }

  /**
   * 某成员的投递计数。
   *   open        还没了结的（在投递/处理中/排队）
   *   expired     **超时未回**（重试用尽）
   *   interrupted 人类主动叫停（不算成员失职，单独计）
   *   replied     已实质回应
   *
   * @param {string} agent
   * @param {{ windowMs?: number }} options
   *   windowMs > 0 时只统计窗口内的终结记录：旧账不该永久给成员挂牌子
   *   （成员后来恢复正常了，徽标也该跟着恢复）。
   */
  countsFor(agent, { windowMs = 0 } = {}) {
    let open = 0;
    let expired = 0;
    let interrupted = 0;
    let replied = 0;
    const now = this.now();
    for (const record of this.records.values()) {
      if (record.agent !== agent) continue;
      const fresh = windowMs <= 0 || now - (record.updatedAt || 0) <= windowMs;
      if (record.state === 'replied') {
        if (fresh) replied += 1;
      } else if (record.state === 'expired') {
        if (!fresh) continue;
        if (record.endedBy === 'interrupted') interrupted += 1;
        else expired += 1;
      } else {
        open += 1;
      }
    }
    return { open, expired, interrupted, replied };
  }

  #view(record) {
    return {
      messageId: record.messageId,
      agent: record.agent,
      seq: record.seq,
      topic: record.topic,
      state: record.state,
      channel: record.channel,
      attempts: record.attempts,
      note: record.note,
      updatedAt: record.updatedAt,
      deadlineAt: record.deadlineAt,
      // 契约判据要用到「回执截止」：送达后 ackTimeoutSeconds 内应当有一条「处理中」，
      // 没有就是"没开始"。这个字段以前只在账本内部用，现在要露给面板与哨兵。
      ackDeadlineAt: record.ackDeadlineAt || null,
      ackOverdue: Boolean(record.ackDeadlineAt && this.now() > record.ackDeadlineAt),
      overdue: Boolean(record.deadlineAt && this.now() > record.deadlineAt),
    };
  }

  /** 名册/哨兵一次要问全部成员：按成员分组返回未完成投递。 */
  open({ ignore } = {}) {
    const byAgent = new Map();
    for (const record of this.records.values()) {
      if (TERMINAL.has(record.state) || record.state === 'expired') continue;
      if (typeof ignore === 'function' && ignore(record.agent)) continue;
      if (!byAgent.has(record.agent)) byAgent.set(record.agent, []);
      byAgent.get(record.agent).push(this.#view(record));
    }
    for (const list of byAgent.values()) list.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    return byAgent;
  }

  /**
   * 通道重启导致的一轮丢失：**立即**回到 queued 重投（终态无关）。
   * 与 markInterrupted 的区别：打断是人类主动叫停（终结、不重投），
   * 这里是基础设施把活弄丢了（必须马上重试），所以不能等 180 秒租约。
   */
  markLost(message) {
    if (!message.replyTo) return null;
    const key = DeliveryLedger.keyOf(message.replyTo, message.agent);
    if (!this.records.has(key)) return null;
    return this.#set(message.replyTo, message.agent, 'queued', {
      note: '通道重启导致这一轮丢失，已立即重投',
      deadlineAt: null,
    });
  }

  /**
   * 租约巡检：到期的 delivered / working 记为 expired；还有重试次数的自动回到 queued 等待重投。
   *
   * @param {{ renewFor?: (record: object) => boolean, maxRenewals?: number }} options
   *   renewFor(record) 返回 true 才续租：由调用方判断"该成员是否**自报正在处理这一条**"。
   *   注意不能用"成员在线就续租"——那样一个被弄丢的活会被无限续租，
   *   永远不判超时，用户看到的就是"永远没反应"。
   * @returns {{ expired: object[], reclaimed: object[], renewed: number }}
   */
  sweep({ renewFor, holdFor, maxRenewals = this.maxRenewals } = {}) {
    const now = this.now();
    const expired = [];
    const reclaimed = [];
    let renewed = 0;
    let held = 0;
    for (const record of [...this.records.values()]) {
      if (TERMINAL.has(record.state) || record.state === 'expired') continue;

      // 声明「需人工唤起」的成员：点名不该判它超时，而是挂起等人类去唤起它的对话。
      // 这类成员（只能人工交互的网页版）本就不自主回答，记它超时是冤枉的。
      if (record.deadlineAt && now >= record.deadlineAt && typeof holdFor === 'function' && holdFor(this.#view(record))) {
        this.#set(record.messageId, record.agent, record.state, {
          note: '等待人工唤起（该成员声明需要人类唤起它的对话）',
          deadlineAt: now + 24 * 3600 * 1000,
        });
        held += 1;
        continue;
      }

      // 兜底：已送达但成员连"处理中"都没回 → 判定信封丢了（例如投给了已断开的连接）
      if (record.state === 'delivered' && record.ackDeadlineAt && now >= record.ackDeadlineAt) {
        const view = this.#view(record);
        expired.push(view);
        if (record.attempts < this.maxAttempts) {
          this.#set(record.messageId, record.agent, 'queued', {
            attempts: record.attempts,
            note: `已送达 ${this.ackTimeoutSeconds} 秒仍未确认收到，判定丢失并重投`,
            deadlineAt: null,
            ackDeadlineAt: null,
            endedBy: 'timeout',
          });
          reclaimed.push(view);
        } else {
          this.#set(record.messageId, record.agent, 'expired', {
            attempts: record.attempts,
            note: '多次送达均未被确认，已登记为未送达',
            deadlineAt: null,
            endedBy: 'timeout',
            ackDeadlineAt: null,
          });
        }
        continue;
      }

      if (!record.deadlineAt || now < record.deadlineAt) continue;

      const canRenew = (record.renewals || 0) < maxRenewals;
      if (canRenew && typeof renewFor === 'function' && renewFor(this.#view(record))) {
        this.#set(record.messageId, record.agent, record.state, {
          note: `成员自报正在处理该条，续租（第 ${(record.renewals || 0) + 1}/${maxRenewals} 次）`,
          deadlineAt: now + this.leaseSeconds * 1000,
          renewals: (record.renewals || 0) + 1,
        });
        renewed += 1;
        continue;
      }

      const view = this.#view(record);
      expired.push(view);
      if (record.attempts < this.maxAttempts) {
        this.#set(record.messageId, record.agent, 'queued', {
          attempts: record.attempts,
          note: `租约到期（${this.leaseSeconds}s）未收到实质回复，已回收重投`,
          deadlineAt: null,
          endedBy: 'timeout',
        });
        reclaimed.push(view);
      } else {
        this.#set(record.messageId, record.agent, 'expired', {
          attempts: record.attempts,
          note: `租约到期且已达重试上限（${this.maxAttempts} 次）`,
          deadlineAt: null,
          endedBy: 'timeout',
        });
      }
    }
    return { expired, reclaimed, renewed, held };
  }

  /**
   * 台账计数。
   * @param {{ ignore?: Set<string>|string[] }} options
   *   ignore：不参与统计的成员（例如隐藏的本机操作员——它是"人"，
   *   @本机 的历史投递会一直挂在 queued，把侧栏「投递中」撑成噪声）。
   */
  summary({ ignore } = {}) {
    const skip = ignore instanceof Set ? ignore : new Set(ignore || []);
    const counts = { queued: 0, delivered: 0, working: 0, replied: 0, expired: 0 };
    for (const record of this.records.values()) {
      if (skip.has(record.agent)) continue;
      counts[record.state] = (counts[record.state] || 0) + 1;
    }
    return {
      counts,
      leaseSeconds: this.leaseSeconds,
      maxAttempts: this.maxAttempts,
      maxRenewals: this.maxRenewals,
      ackTimeoutSeconds: this.ackTimeoutSeconds,
    };
  }

  snapshot() {
    return this.order.map((key) => this.#view(this.records.get(key)));
  }
}
