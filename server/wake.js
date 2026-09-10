// Message Board · 点名唤醒
//
// 「@ 发出后立刻唤醒被点名的成员」，而不是等它下次主动读板。
//
// 四条通道，按优先级：
//   1. inbox —— 成员正挂着长轮询 GET /api/inbox?agent=<id>&wait=N → 立刻把点名信封交给它；
//   2. callback —— 成员接入时报了回调地址 → 立刻 POST 点名信封过去；
//   3. command —— 运维在 board.config.json 里为该成员配置了本机唤醒命令 → 立刻拉起进程；
//   4. queued —— 以上都没有 → 进队列，等它下次长轮询或读板时取走（界面显示「待唤醒」）。
//
// 唤醒结果只追加记录，不回写留言本身（留言是只追加的事实）。

import { spawn } from 'node:child_process';

import { SCHEMA, localIso } from './protocol.js';

const MAX_WAIT_MS = 60000;

function placeholder(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) => (key in values ? values[key] : match));
}

export class WakeHub {
  constructor({ root, baseUrl = '', callbackTimeoutMs = 5000, maxQueue = 50, onEvent = () => {} } = {}) {
    this.root = root;
    this.baseUrl = baseUrl;
    this.callbackTimeoutMs = callbackTimeoutMs;
    this.maxQueue = maxQueue;
    this.onEvent = onEvent;
    this.waiters = new Map(); // agentId → Set<entry>
    this.queues = new Map(); // agentId → envelope[]
    this.results = []; // 最近的唤醒结果（供 /api/state 与审计）
    this.counters = { inbox: 0, callback: 0, command: 0, queued: 0, failed: 0 };
  }

  /** 组装点名信封：成员被唤醒后拿到的就是这份 JSON。 */
  envelope(message, agentId) {
    return {
      schema: SCHEMA,
      type: 'mention',
      agent: agentId,
      from: message.agent,
      fromName: message.agentName,
      messageId: message.id,
      seq: message.seq,
      topic: message.topic,
      status: message.status,
      mentions: message.mentions,
      text: message.text,
      at: message.ts,
      board: this.baseUrl,
      next: `读板 GET ${this.baseUrl}/api/state?limit=50，并用 replyTo="${message.id}" 给出实质回复`,
    };
  }

  #waitersOf(agentId) {
    if (!this.waiters.has(agentId)) this.waiters.set(agentId, new Set());
    return this.waiters.get(agentId);
  }

  /** 取一个正在等待的 inbox；没有则返回 null。 */
  #takeWaiter(agentId) {
    const set = this.waiters.get(agentId);
    if (!set || !set.size) return null;
    const entry = set.values().next().value;
    set.delete(entry);
    clearTimeout(entry.timer);
    return entry;
  }

  #enqueue(agentId, envelope) {
    const queue = this.queues.get(agentId) || [];
    queue.push(envelope);
    while (queue.length > this.maxQueue) queue.shift();
    this.queues.set(agentId, queue);
  }

  /**
   * 长轮询：立刻返回已排队或即将到达的点名。
   * @param {string} agentId
   * @param {{ waitMs?: number }} options
   */
  inbox(agentId, { waitMs = 0 } = {}) {
    const queue = this.queues.get(agentId);
    if (queue && queue.length) return Promise.resolve({ envelope: queue.shift(), from: 'queued' });

    const ms = Math.max(0, Math.min(Number(waitMs) || 0, MAX_WAIT_MS));
    if (ms === 0) return Promise.resolve({ envelope: null, from: 'none' });

    return new Promise((resolve) => {
      const entry = { resolve, timer: null };
      entry.timer = setTimeout(() => {
        this.#waitersOf(agentId).delete(entry);
        resolve({ envelope: null, from: 'timeout' });
      }, ms);
      if (typeof entry.timer.unref === 'function') entry.timer.unref();
      this.#waitersOf(agentId).add(entry);
    });
  }

  /** 清空某成员的长轮询（用于取消/断线）。 */
  clearWaiters(agentId) {
    const set = this.waiters.get(agentId);
    if (!set) return;
    for (const entry of set) {
      clearTimeout(entry.timer);
      entry.resolve({ envelope: null, from: 'cancelled' });
    }
    set.clear();
  }

  /** 投递一次唤醒，返回 { channel, ok, error }。 */
  async deliver(agent, envelope) {
    const result = { agent: agent.id, messageId: envelope.messageId, seq: envelope.seq, at: localIso() };

    const waiter = this.#takeWaiter(agent.id);
    if (waiter) {
      waiter.resolve({ envelope, from: 'inbox' });
      result.channel = 'inbox';
      result.ok = true;
      return this.#record(result);
    }

    const callback = agent.wake && agent.wake.type === 'callback' ? agent.wake.url : '';
    if (callback) {
      try {
        const response = await fetch(callback, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(envelope),
          signal: AbortSignal.timeout(this.callbackTimeoutMs),
        });
        if (response.ok) {
          result.channel = 'callback';
          result.ok = true;
          return this.#record(result);
        }
        result.channel = 'callback';
        result.ok = false;
        result.error = `HTTP ${response.status}`;
        this.#enqueue(agent.id, envelope);
        return this.#record(result);
      } catch (error) {
        result.channel = 'callback';
        result.ok = false;
        result.error = error.message;
        this.#enqueue(agent.id, envelope);
        return this.#record(result);
      }
    }

    const command = agent.wakeCommand || '';
    if (command) {
      const values = {
        id: agent.id,
        name: agent.name,
        text: envelope.text,
        topic: envelope.topic || '',
        seq: String(envelope.seq),
        messageId: envelope.messageId,
        board: this.baseUrl,
      };
      try {
        const child = spawn(placeholder(command, values), {
          cwd: this.root,
          shell: true,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        child.unref();
        result.channel = 'command';
        result.ok = true;
        result.command = placeholder(command, values);
        return this.#record(result);
      } catch (error) {
        result.channel = 'command';
        result.ok = false;
        result.error = error.message;
        this.#enqueue(agent.id, envelope);
        return this.#record(result);
      }
    }

    this.#enqueue(agent.id, envelope);
    return this.#record({ ...result, channel: 'queued', ok: true });
  }

  #record(result) {
    this.results.push(result);
    while (this.results.length > 500) this.results.shift();
    const counter = result.ok ? result.channel : 'failed';
    if (counter in this.counters) this.counters[counter] += 1;
    else this.counters.failed += 1;
    try {
      this.onEvent(result);
    } catch {
      /* 订阅者异常不影响唤醒 */
    }
    return result;
  }

  /** 某条留言的唤醒结果（供界面显示「已唤醒 / 待唤醒」）。 */
  statusFor(messageId) {
    return this.results.filter((item) => item.messageId === messageId);
  }

  snapshot(limit = 100) {
    return { counters: { ...this.counters }, results: this.results.slice(-limit) };
  }

  queueDepth() {
    const out = {};
    for (const [agentId, queue] of this.queues) if (queue.length) out[agentId] = queue.length;
    return out;
  }
}
