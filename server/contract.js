// Message Board · 契约状态（点名 → 回执 → 结果）
//
// 这个项目真正的要求不是「成员在线」，而是**契约被履行**：
//   被点名后必须先回应「任务开始」，完成后再回应结果。
// 在线只是代理指标，它可以被"挂个心跳"骗过去；契约不会——它看的是账本里的四个事实：
//
//   queued     点名进了队列，还没人取走        → 超时 = 没人取件
//   delivered  已送达，等对方回「处理中」      → 超过 ackDeadline 仍无回执 = 没开始
//   working    对方已回执「开始处理」          → 超过交付预算还没结果 = 开始了没交付
//   replied    已给出实质回复                  → 履行完毕
//
// 判定只在这里实现一次：服务端拿它给面板排序与显示，哨兵拿它报警与接管，测试直接测它。
// 面板上"在线/忙碌"是进程状态（参考信息），"已回执 / 正在处理 #N / 未回执 N 分钟"才是契约状态。

/** 契约的六种进行中状态 + 三种无需动作的状态。 */
export const CONTRACT = {
  IDLE: 'idle', // 没有未完成的点名
  MANUAL: 'manual', // 声明需人工唤起：等人是它的正常形态
  QUEUED: 'queued', // 排队中（还在 ack 窗口内）
  WAITING_ACK: 'waiting-ack', // 已送达，等「开始」回执
  WORKING: 'working', // 已回执，正在处理
  NOT_FETCHED: 'not-fetched', // 超时没人取件
  NO_ACK: 'no-ack', // 超时没有「开始」回执
  OVERDUE: 'overdue', // 开始了但没在预算内交付
  UNFULFILLED: 'unfulfilled', // 重试用尽仍无实质回复（账本已判 expired）
};

/** 需要报警/接管的契约违约状态。 */
export const BREACH_STATES = [CONTRACT.NOT_FETCHED, CONTRACT.NO_ACK, CONTRACT.OVERDUE, CONTRACT.UNFULFILLED];

const LABELS = {
  [CONTRACT.IDLE]: '无待办',
  [CONTRACT.MANUAL]: '需人工唤起',
  [CONTRACT.QUEUED]: '排队中',
  [CONTRACT.WAITING_ACK]: '已送达，等回执',
  [CONTRACT.WORKING]: '正在处理',
  [CONTRACT.NOT_FETCHED]: '没人取件',
  [CONTRACT.NO_ACK]: '没回执（未开始）',
  [CONTRACT.OVERDUE]: '开始了没交付',
  [CONTRACT.UNFULFILLED]: '作废未回应',
};

/** 让「等了几分钟」这种话在面板上不至于变成一屏数字。 */
export function humanSeconds(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`;
  return `${Math.round(seconds / 360) / 10} 小时`;
}

/**
 * 判定一个成员的契约状态。
 *
 * @param {object[]} views 该成员**未完成**的投递视图（delivery.openForAgent）
 * @param {{ respondMode?: string, nowMs?: number, ackTimeoutSeconds?: number, deliveryBudgetSeconds?: number }} options
 */
export function contractOf(views = [], options = {}) {
  const {
    respondMode = 'autonomous',
    nowMs = Date.now(),
    ackTimeoutSeconds = 45,
    deliveryBudgetSeconds = 900,
  } = options;

  // 作废（重试用尽仍无实质回复）是**最硬的违约**：账本已经不指望它了，可点名从来没被答复。
  // 人类主动叫停（endedBy=interrupted）不算成员失职，调用方必须先把这类排除掉。
  const expired = (views || []).filter((view) => view && view.state === 'expired');
  const open = (views || []).filter((view) => view && view.state !== 'replied' && view.state !== 'expired');
  if (!open.length && !expired.length) {
    return { state: CONTRACT.IDLE, label: LABELS[CONTRACT.IDLE], severity: 'info', waitingSeconds: null, seq: null, detail: '没有未完成的点名。' };
  }

  // 等人回复不是故障：manual 成员的等待由人类决定，不该被记成违约
  if (respondMode === 'manual' && !expired.length) {
    const oldest = oldestOf(open, nowMs);
    return {
      state: CONTRACT.MANUAL,
      label: LABELS[CONTRACT.MANUAL],
      severity: 'info',
      waitingSeconds: oldest.waitingSeconds,
      seq: oldest.view.seq ?? null,
      detail: `有 ${open.length} 条点名在等人类唤起它的对话（最老 #${oldest.view.seq} 已等 ${humanSeconds(oldest.waitingSeconds)}）。`,
    };
  }

  // 取最"卡"的一条来代表这个成员：违约优先，其次最早开始的
  const ranked = [...expired, ...open]
    .map((view) => ({ view, ...describe(view, { nowMs, ackTimeoutSeconds, deliveryBudgetSeconds }) }))
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.waitingSeconds - a.waitingSeconds);
  const top = ranked[0];
  return {
    state: top.state,
    label: top.label,
    severity: top.severity,
    waitingSeconds: top.waitingSeconds,
    seq: top.view.seq ?? null,
    open: open.length + expired.length,
    detail: top.detail,
  };
}

function severityRank(severity) {
  return severity === 'alert' ? 2 : severity === 'warn' ? 1 : 0;
}

/** 在某个状态里等了多久：用状态最后一次变更的时间做锚点。
 *  账本里的 updatedAt 是 epoch 毫秒，别的地方可能给 ISO 字符串——两种都认。 */
function waitedSeconds(view, nowMs) {
  const raw = view.updatedAt;
  const since = typeof raw === 'number' ? raw : Date.parse(raw || '') || 0;
  return since ? Math.max(0, Math.round((nowMs - since) / 1000)) : 0;
}

function oldestOf(open, nowMs) {
  return open
    .map((view) => ({ view, waitingSeconds: waitedSeconds(view, nowMs) }))
    .sort((a, b) => b.waitingSeconds - a.waitingSeconds)[0];
}

function describe(view, { nowMs, ackTimeoutSeconds, deliveryBudgetSeconds }) {
  const waitingSeconds = waitedSeconds(view, nowMs);
  const seq = view.seq ?? '?';
  const waited = humanSeconds(waitingSeconds);
  if (view.state === 'expired') {
    return {
      state: CONTRACT.UNFULFILLED,
      label: LABELS[CONTRACT.UNFULFILLED],
      severity: 'alert',
      waitingSeconds,
      detail: `点名 #${seq} 已作废：送达后重试用尽仍没有实质回复（最后一次动作在 ${waited}前）。点名从来没有被答复，需要重新派给一个能交付的通道。`,
    };
  }  if (view.state === 'queued') {
    return waitingSeconds >= ackTimeoutSeconds
      ? {
          state: CONTRACT.NOT_FETCHED,
          label: LABELS[CONTRACT.NOT_FETCHED],
          severity: 'alert',
          waitingSeconds,
          detail: `点名 #${seq} 进队列 ${waited}了，还没人取件（唤醒通道没接走它，也没人读板）。`,
        }
      : {
          state: CONTRACT.QUEUED,
          label: LABELS[CONTRACT.QUEUED],
          severity: 'info',
          waitingSeconds,
          detail: `点名 #${seq} 在队列里等了 ${waited}，还没被取走。`,
        };
  }
  if (view.state === 'delivered') {
    const ackOverdue = Boolean(view.ackDeadlineAt) && nowMs > view.ackDeadlineAt;
    return ackOverdue
      ? {
          state: CONTRACT.NO_ACK,
          label: LABELS[CONTRACT.NO_ACK],
          severity: 'alert',
          waitingSeconds,
          detail: `点名 #${seq} 已送达，但超过 ${ackTimeoutSeconds} 秒没有任何「开始处理」的回执——按契约这等于没开始。`,
        }
      : {
          state: CONTRACT.WAITING_ACK,
          label: LABELS[CONTRACT.WAITING_ACK],
          severity: 'info',
          waitingSeconds,
          detail: `点名 #${seq} 已送达，等它回一条「处理中」（等了 ${waited}）。`,
        };
  }
  if (view.state === 'working') {
    return waitingSeconds >= deliveryBudgetSeconds
      ? {
          state: CONTRACT.OVERDUE,
          label: LABELS[CONTRACT.OVERDUE],
          severity: 'alert',
          waitingSeconds,
          detail: `点名 #${seq} 已经回执开始处理，但 ${waited} 内没有交付结果（交付预算 ${Math.round(deliveryBudgetSeconds / 60)} 分钟）。`,
        }
      : {
          state: CONTRACT.WORKING,
          label: `${LABELS[CONTRACT.WORKING]} #${seq}`,
          severity: 'info',
          waitingSeconds,
          detail: `点名 #${seq} 已回执开始处理，正在进行（已 ${waited}）。`,
        };
  }
  return {
    state: view.state || 'unknown',
    label: view.state || '未知',
    severity: 'warn',
    waitingSeconds,
    detail: `点名 #${seq} 处于未知投递状态 ${view.state}。`,
  };
}
