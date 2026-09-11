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
    this.inboxActivity = new Map(); // agentId → { lastRequestAt, lastLongPollAt, lastWaitMs }
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

  /** 取一个正在等待的 inbox；没有则返回 null。
   *
   *  同一个成员可能有两个客户端在挂长轮询：我们的运行器（会自报身份）、以及成员自带的
   *  外部客户端（往往什么都不报）。默认"先来先得"会把信交给先挂上的那个，而它可能拿了就不干活
   *  （实测 #161/#165：外部客户端两次接走、两次什么都不做，我们的运行器一次都没收到）。
   *
   *  取件顺序因此改成：**自报身份且靠谱的 → 自报身份的 → 匿名的**。
   *  自报身份是"可以被追责"的前提；匿名客户端只在没有别人接的时候才拿得到信。 */
  #takeWaiter(agentId, { prefer } = {}) {
    const set = this.waiters.get(agentId);
    if (!set || !set.size) return null;
    let entry = null;
    if (typeof prefer === 'function') {
      for (const candidate of set.values()) {
        if (candidate.client && prefer(candidate.client)) {
          entry = candidate;
          break;
        }
      }
    }
    if (!entry) {
      for (const candidate of set.values()) {
        if (candidate.client) {
          entry = candidate;
          break;
        }
      }
    }
    if (!entry) entry = set.values().next().value;
    set.delete(entry);
    clearTimeout(entry.timer);
    if (entry.onAbort && entry.signal) {
      try {
        entry.signal.removeEventListener('abort', entry.onAbort);
      } catch {
        /* 忽略 */
      }
    }
    return entry;
  }

  #enqueue(agentId, envelope) {
    const queue = this.queues.get(agentId) || [];
    // 同一条留言不在队列里塞第二份：重复件会导致"回复已经到了，却又投递一次、
    // 那一份没人应、超时作废"，面板于是显示"作废未回应"（实测踩过）。
    if (envelope && envelope.messageId && queue.some((item) => item && item.messageId === envelope.messageId)) return;
    queue.push(envelope);
    while (queue.length > this.maxQueue) queue.shift();
    this.queues.set(agentId, queue);
  }

  /**
   * 长轮询：立刻返回已排队或即将到达的点名。
   * @param {string} agentId
   * @param {{ waitMs?: number }} options
   */
  /**
   * 挂一次长轮询。
   *
   * signal：HTTP 连接关闭时由路由层 abort。**必须有**——否则进程被杀后，
   * 它留下的 waiter 会继续挂在服务端直到超时，期间新点名可能被投递给这个死 waiter，
   * 结果信件出了队列却没人收到（实测：投递显示已送达，成员侧毫无反应，只能等 180 秒租约）。
   */
  inbox(agentId, { waitMs = 0, signal, client = null } = {}) {
    const queue = this.queues.get(agentId);
    if (queue && queue.length) return Promise.resolve({ envelope: queue.shift(), from: 'queued', client: null });

    const ms = Math.max(0, Math.min(Number(waitMs) || 0, MAX_WAIT_MS));
    // 记录"这个成员确实会挂轮询"，用于接入验收（不问自述，只看行为）
    const activity = this.inboxActivity.get(agentId) || {};
    activity.lastRequestAt = Date.now();
    activity.lastWaitMs = ms;
    if (ms > 0) activity.lastLongPollAt = Date.now();
    this.inboxActivity.set(agentId, activity);
    if (ms === 0) return Promise.resolve({ envelope: null, from: 'none' });

    return new Promise((resolve) => {
      const entry = { resolve, timer: null, onAbort: null, signal: signal || null, client: client || null };
      const finish = (payload) => {
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.onAbort && signal) {
          try {
            signal.removeEventListener('abort', entry.onAbort);
          } catch {
            /* 忽略 */
          }
        }
        this.#waitersOf(agentId).delete(entry);
        resolve(payload);
      };
      entry.finish = finish;
      entry.timer = setTimeout(() => finish({ envelope: null, from: 'timeout' }), ms);
      if (typeof entry.timer.unref === 'function') entry.timer.unref();

      if (signal) {
        if (signal.aborted) {
          finish({ envelope: null, from: 'aborted' });
          return;
        }
        entry.onAbort = () => finish({ envelope: null, from: 'aborted' });
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
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

  /** 把一条点名重新放进队列（租约到期回收时用）。 */
  requeue(agentId, envelope) {
    this.#enqueue(agentId, envelope);
    return (this.queues.get(agentId) || []).length;
  }

  /** 投递一个控制指令（例如「打断」）：走同一条 inbox 通道，成员取到后自行执行。 */
  pushControl(agentId, control) {
    this.#enqueue(agentId, {
      schema: SCHEMA,
      type: 'control',
      agent: agentId,
      action: control.action,
      reason: control.reason || '',
      issuedBy: control.issuedBy || 'local',
      at: localIso(),
      board: this.baseUrl,
    });
    return (this.queues.get(agentId) || []).length;
  }

  /** 投递一次唤醒，返回 { channel, ok, error, client }。 */
  async deliver(agent, envelope, { preferClient } = {}) {
    const result = { agent: agent.id, messageId: envelope.messageId, seq: envelope.seq, at: localIso() };

    const waiter = this.#takeWaiter(agent.id, { prefer: preferClient });
    if (waiter) {
      waiter.resolve({ envelope, from: 'inbox' });
      result.channel = 'inbox';
      result.ok = true;
      // 记下是哪个客户端接走的：它要是拿了不交付，账本下一轮就能认出来
      result.client = waiter.client || null;
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

  /**
   * 唤醒通道的**客观**状态：不是成员自述，而是服务端观测到的行为。
   *  - inbox：最近是否真的挂过带等待的长轮询、此刻是否挂着
   *  - callback：最近一次回调投递是否成功
   *  - command：运维是否配置了本机唤醒命令
   *  - queue：还有几条点名没送出去
   */
  channelState(agent, { recentMs = 120000 } = {}) {
    const activity = this.inboxActivity.get(agent?.id) || {};
    const now = Date.now();
    const lastCallback = [...this.results].reverse().find((item) => item.agent === agent?.id && item.channel === 'callback');
    return {
      inbox: {
        waiting: (this.waiters.get(agent?.id)?.size || 0) > 0,
        lastLongPollAt: activity.lastLongPollAt || null,
        recent: Boolean(activity.lastLongPollAt && now - activity.lastLongPollAt <= recentMs),
        lastWaitMs: activity.lastWaitMs || 0,
      },
      callback: lastCallback ? { ok: lastCallback.ok, at: lastCallback.at, error: lastCallback.error || null } : null,
      command: Boolean(agent?.wakeCommand),
      queue: (this.queues.get(agent?.id) || []).length,
    };
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
