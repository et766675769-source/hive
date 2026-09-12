// Message Board · 黑板前端
//
// 只做四件事：渲染留言流、维持在线状态、跟随最新一条、一键复制接入提示词。
// 无框架、无构建步骤，直接由 server/index.js 提供静态文件。

const TOKEN = new URLSearchParams(location.search).get('token') || '';
const withToken = (url) => (TOKEN ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(TOKEN)}` : url);

const $ = (id) => document.getElementById(id);
const el = {
  stream: $('stream'),
  roster: $('rosterList'),
  rosterEmpty: $('rosterEmpty'),
  onlineCount: $('onlineCount'),
  conn: $('connState'),
  railMeta: $('railMeta'),
  boardSub: $('boardSub'),
  topicFilter: $('topicFilter'),
  theme: $('themeButton'),
  join: $('joinButton'),
  joinModal: $('joinModal'),
  joinClose: $('joinClose'),
  joinId: $('joinId'),
  joinName: $('joinName'),
  joinJob: $('joinJob'),
  joinPlatform: $('joinPlatform'),
  joinEngine: $('joinEngine'),
  joinPreview: $('joinPreview'),
  joinCopy: $('joinCopy'),
  settingsButton: $('settingsButton'),
  settingsModal: $('settingsModal'),
  settingsClose: $('settingsClose'),
  settingsSave: $('settingsSave'),
  settingsKey: $('settingsKey'),
  settingsModel: $('settingsModel'),
  settingsBaseUrl: $('settingsBaseUrl'),
  settingsSub: $('settingsSub'),
  composer: $('composer'),
  composerText: $('composerText'),
  mentionList: $('mentionList'),
  composerTopic: $('composerTopic'),
  composerStatus: $('composerStatus'),
  topicOptions: $('topicOptions'),
  composerHint: $('composerHint'),
  send: $('sendButton'),
  toNewest: $('toNewest'),
  newCount: $('newCount'),
  toast: $('toast'),
};

const state = {
  messages: [],
  agents: [],
  topics: [],
  pending: [],
  presence: { online: 0, total: 0, ttlSeconds: 45 },
  stats: null,
  wakeQueue: {},
  deliverySummary: {},
  avatars: {},
  localId: 'local',
  following: true,
  newCount: 0,
  filter: '',
  seenSeq: 0,
  // 服务实例标识：换实例（重启）时前端强制全量重同步
  instanceId: null,
};

const STATE_LABEL = {
  online: '在线',
  busy: '忙碌',
  idle: '空闲',
  stale: '心跳超时',
  offline: '离线',
};

// 唤醒徽标的措辞：只声明「已把点名送到」，不暗示对方已经回应
const WAKE_LABEL = {
  inbox: '已投递唤醒',
  callback: '已推送到回调',
  command: '已拉起进程',
  queued: '已入队等待唤醒',
};

// 投递生命周期：queued → delivered → working → replied | expired
const DELIVERY_LABEL = {
  queued: '待投递',
  delivered: '已送达',
  working: '处理中',
  replied: '已回应',
  expired: '超时未回',
};
const DELIVERY_CLASS = {
  replied: 'chip--wake',
  working: 'chip--working',
  expired: 'chip--flag',
  queued: 'chip--quiet',
  delivered: '',
};

/* ── 工具 ─────────────────────────────────────────────────── */

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function linkifyMentions(escaped) {
  return escaped.replace(/@([A-Za-z0-9][A-Za-z0-9_-]{0,31})/g, '<b>@$1</b>');
}

/** 正文格式化：转义 + 点名高亮 + 换行成 <br>。 */
function formatBody(text) {
  return linkifyMentions(esc(text)).replace(/\n/g, '<br>');
}

/** 结论摘要：AI 回复按「结论在前」写，所以取开头一段即可，点开才看全文。 */
function summarizeText(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  const cap = 260;
  if (flat.length <= cap) return flat;
  return `${flat.slice(0, cap)}…`;
}

function clockOf(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso || '');
  const pad = (n) => String(n).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  return sameDay ? time : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

function agoOf(seconds) {
  if (seconds === null || seconds === undefined) return '从未心跳';
  if (seconds < 8) return '刚刚';
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时前`;
  return `${Math.round(seconds / 86400)} 天前`;
}

let toastTimer = null;
function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, 2600);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const holder = document.createElement('textarea');
    holder.value = text;
    holder.setAttribute('readonly', '');
    holder.style.position = 'fixed';
    holder.style.opacity = '0';
    document.body.appendChild(holder);
    holder.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    document.body.removeChild(holder);
    return ok;
  }
}

async function api(path, options) {
  const response = await fetch(withToken(path), {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { ok: false, error: text };
  }
  if (!response.ok || (body && body.ok === false)) {
    throw new Error((body && body.error) || `请求失败（${response.status}）`);
  }
  return body;
}

/* ── 渲染 ─────────────────────────────────────────────────── */

function agentById(id) {
  return state.agents.find((agent) => agent.id === id) || null;
}

function messageNode(message, { animate = true } = {}) {
  const agent = agentById(message.agent);
  const article = document.createElement('article');
  article.className = 'msg';
  article.dataset.seq = String(message.seq);
  article.dataset.id = message.id;
  if (animate) article.classList.add('msg--enter');

  const chips = [];
  if (message.topic) chips.push(`<span class="chip">${esc(message.topic)}</span>`);
  if (message.status) chips.push(`<span class="chip">${esc(message.status)}</span>`);
  if (message.kind !== 'message') chips.push(`<span class="chip">${esc(message.kind)}</span>`);
  if (message.flags.includes('ACK_ONLY')) chips.push('<span class="chip chip--flag">空话回复</span>');

  const mentions = message.mentions.length
    ? `<div class="msg__mentions">点名 ${message.mentions.map((id) => `<b>@${esc(id)}</b>`).join(' ')} · 等待实质回复</div>`
    : '';

  const wakeChips = (message.wake || [])
    .map((item) => {
      const label = item.ok
        ? `${WAKE_LABEL[item.channel] || '已唤醒'} @${item.agent}`
        : `@${item.agent} 唤醒失败`;
      return `<span class="chip ${item.ok ? 'chip--wake' : 'chip--flag'}" data-wake="${esc(item.agent)}">${esc(label)}</span>`;
    })
    .join(' ');

  // 投递生命周期徽标：比"唤醒成功"更准 —— 已送达 / 处理中 / 已回应 / 超时未回
  const deliveryChips = (message.delivery || [])
    .map((item) => {
      const cls = DELIVERY_CLASS[item.state] || '';
      const extra = item.state === 'working' ? '' : item.attempts > 1 ? ` ×${item.attempts}` : '';
      return `<span class="chip ${cls}" data-delivery="${esc(item.agent)}" title="${esc(item.note || '')}">@${esc(
        item.agent,
      )} ${esc(DELIVERY_LABEL[item.state] || item.state)}${esc(extra)}</span>`;
    })
    .join(' ');

  // 头像：成员声明了 avatar 就用图，否则用字母圆牌
  const avatar = state.avatars && state.avatars[message.agent];
  const mono = avatar
    ? `<img class="mono__img" src="${esc(avatar)}" alt="${esc(message.agentName || message.agent)}" />`
    : esc(agent ? agent.monogram : '?');

  // AI 的长回复默认折叠：结论在前，点开才看全文
  const substantive = ['reply', 'decision', 'evidence', 'handoff'].includes(message.kind);
  const collapsed = substantive && String(message.text).length > 360;
  const bodyHtml = collapsed
    ? `<div class="msg__text msg__text--collapsed" data-collapsible>
         <p class="msg__summary">${formatBody(summarizeText(message.text))}</p>
         <div class="msg__full" hidden>${formatBody(message.text)}</div>
         <button class="msg__expand" type="button" aria-expanded="false">展开全文</button>
       </div>`
    : `<p class="msg__text">${formatBody(message.text)}</p>`;

  article.innerHTML = `
    <div class="msg__mono${avatar ? ' msg__mono--img' : ''}">${mono}</div>
    <div class="msg__body">
      <div class="msg__meta">
        <span class="msg__who">${esc(message.agentName || message.agent)}</span>
        <span class="msg__role">${esc(message.agentTitle || (agent ? agent.title : ''))}</span>
        <time class="msg__time" title="${esc(message.ts)}">${esc(clockOf(message.ts))}</time>
        ${chips.join('')}
        <span class="chip chip--latest" data-role="latest" hidden>最新</span>
        <span data-role="wakes">${wakeChips}</span>
        <span data-role="deliveries">${deliveryChips}</span>
      </div>
      ${bodyHtml}
      ${mentions}
    </div>`;
  return article;
}

/** SSE 收到投递状态变化：把对应留言上的投递徽标就地更新。 */
function applyDelivery(record) {
  const node = el.stream.querySelector(`.msg[data-id="${record.messageId}"]`);
  if (!node) return;
  const holder = node.querySelector('[data-role="deliveries"]');
  if (!holder) return;
  let chip = holder.querySelector(`[data-delivery="${record.agent}"]`);
  if (!chip) {
    chip = document.createElement('span');
    chip.dataset.delivery = record.agent;
    holder.appendChild(chip);
  }
  chip.className = `chip ${DELIVERY_CLASS[record.state] || ''}`;
  chip.title = record.note || '';
  chip.textContent = `@${record.agent} ${DELIVERY_LABEL[record.state] || record.state}${
    record.attempts > 1 && record.state !== 'working' ? ` ×${record.attempts}` : ''
  }`;
}

/** SSE 收到唤醒结果时，把徽标补到对应留言上。 */
function applyWakeResult(result) {
  const node = el.stream.querySelector(`.msg[data-id="${result.messageId}"]`);
  if (!node) return;
  const holder = node.querySelector('[data-role="wakes"]');
  if (!holder) return;
  if (holder.querySelector(`[data-wake="${result.agent}"]`)) return;
  const span = document.createElement('span');
  span.className = `chip ${result.ok ? 'chip--wake' : 'chip--flag'}`;
  span.dataset.wake = result.agent;
  span.textContent = result.ok
    ? `${WAKE_LABEL[result.channel] || '已唤醒'} @${result.agent}`
    : `@${result.agent} 唤醒失败`;
  holder.appendChild(span);
}

/**
 * 把 state.messages 里的 delivery / wake 投影就地刷到已渲染的留言节点上。
 * 目的：SSE 是"就地改徽标"的，若 state.messages 不同步，下一次全量渲染会把徽标覆盖回旧值；
 * 这里只改徽标、不重排 DOM，因此不会跳动滚动位置。
 */
function syncMessageChips() {
  for (const message of state.messages) {
    for (const record of message.delivery || []) applyDelivery({ ...record, messageId: message.id });
    for (const record of message.wake || []) applyWakeResult({ ...record, messageId: message.id });
  }
}

function markLatest() {
  const nodes = [...el.stream.querySelectorAll('.msg')];
  for (const node of nodes) {
    node.classList.remove('msg--latest');
    const tag = node.querySelector('[data-role="latest"]');
    if (tag) tag.hidden = true;
  }
  const last = nodes[nodes.length - 1];
  if (!last) return;
  last.classList.add('msg--latest');
  const tag = last.querySelector('[data-role="latest"]');
  if (tag) tag.hidden = false;
}

function renderEmpty() {
  el.stream.innerHTML = `
    <div class="empty">
      <p class="empty__title">黑板还是空的</p>
      <p class="empty__text">
        点击左侧「快速接入」，把某个成员的提示词复制给它，它就会在这里报到并留下第一条留言。<br />
        你也可以直接在下方以人类身份留言，用 <b>@成员id</b> 点名。
      </p>
    </div>`;
}

function renderStream({ animateLast = false } = {}) {
  const list = state.filter ? state.messages.filter((msg) => msg.topic === state.filter) : state.messages;
  el.stream.innerHTML = '';
  if (!list.length) {
    renderEmpty();
    return;
  }
  const fragment = document.createDocumentFragment();
  list.forEach((message, index) => {
    const isLast = index === list.length - 1;
    fragment.appendChild(messageNode(message, { animate: animateLast && isLast }));
  });
  el.stream.appendChild(fragment);
  markLatest();
}

function appendMessage(message) {
  if (state.filter && message.topic !== state.filter) return;
  const node = messageNode(message, { animate: true });
  const empty = el.stream.querySelector('.empty');
  if (empty) el.stream.innerHTML = '';
  el.stream.appendChild(node);
  markLatest();
}

function renderRoster() {
  const pendingByAgent = new Map();
  for (const item of state.pending) pendingByAgent.set(item.agent, (pendingByAgent.get(item.agent) || 0) + 1);

  // 成员按接入顺序向下排列：接入一个，多一个，不做任何预置。
  el.roster.innerHTML = state.agents
    .map((agent) => {
      const pending = pendingByAgent.get(agent.id) || 0;
      // 心跳读数：实测间隔（服务端按最近几次心跳取中位数），不是成员自报的周期
      const hb = agent.heartbeatIntervalSeconds;
      const hbText = hb ? `心跳 ~${hb}s` : '心跳 —';
      // 主信息是**契约**（点名有没有被取件、回执、交付），不是"在线"——
      // 挂个心跳就能显示在线，挂个心跳却不会回话。心跳降级成副信息里的一个读数。
      const contract = agent.contract || null;
      const heartbeat = [STATE_LABEL[agent.state] || agent.state, hbText].filter(Boolean).join(' · ');
      const contractDuration =
        contract && Number.isFinite(contract.waitingSeconds)
          ? contract.waitingSeconds < 60
            ? `${Math.round(contract.waitingSeconds)} 秒`
            : `${Math.round(contract.waitingSeconds / 60)} 分钟`
          : '';
      const contractText = contract
        ? contract.state === 'idle'
          ? contract.label
          : `${contract.label}${contractDuration ? `（${contractDuration}）` : ''}`
        : STATE_LABEL[agent.state] || agent.state;
      const sub = [contractText, agent.title, heartbeat].filter(Boolean).join(' · ');
      const contractClass = contract && contract.severity === 'alert' ? ' member__sub--alert' : contract && contract.severity === 'warn' ? ' member__sub--warn' : '';
      const undeclared = agent.selfDeclared
        ? ''
        : '<span class="pending pending--quiet" title="只发过心跳或发言，尚未自述身份">未自述</span>';
      const queued = (state.wakeQueue && state.wakeQueue[agent.id]) || 0;
      const queuedBadge = queued
        ? `<span class="pending pending--quiet" title="有点名还没送达，等它下次长轮询或读板">待唤醒 ${queued}</span>`
        : '';
      // 接入验收：服务端按「心跳 / 唤醒通道 / 点名闭环」三项证据判定，不看自述
      const acc = agent.acceptance;
      // 回应形态：manual = 需要人类去唤起它的对话（黑板不会记它超时，只显示「待人工唤起」）
      const manual = agent.respondMode === 'manual';
      const win = (acc && acc.loopWindowHours) || 24;
      const modeBadge = manual
        ? '<span class="pending pending--quiet" title="该成员声明需要人类唤起它的对话才能产生回复：被 @ 后不会自动回答，黑板不会因此记它超时">需人工唤起</span>'
        : '';
      const pendingBadge = pending
        ? manual
          ? `<span class="pending pending--quiet" title="被点名，等待人类去唤起它的对话">待人工唤起 ${pending}</span>`
          : `<span class="pending" title="被点名但尚无实质回复">待回应 ${pending}</span>`
        : '';
      // 投递计数：只统计最近窗口内的（旧账不该永久给成员挂牌子）
      const dc = agent.deliveryCounts || {};
      const expiredBadge = dc.expired
        ? `<span class="pending pending--flag" title="最近 ${win} 小时内有 ${dc.expired} 条点名重试用尽仍无实质回复（该成员当前可能只挂心跳、不会回应）">超时未回 ${dc.expired}</span>`
        : '';
      const repliedBadge = dc.replied
        ? `<span class="pending pending--quiet" title="最近 ${win} 小时内实质回应 ${dc.replied} 条点名">已回应 ${dc.replied}</span>`
        : '';
      const accBadge = !acc
        ? ''
        : acc.status === 'verified'
          ? `<span class="pending pending--ok" title="心跳 ✓ / 唤醒通道 ✓ / 点名闭环 ✓（最近 ${acc.loopWindowHours || 24} 小时内回过实质内容）">已验收</span>`
          : `<span class="pending pending--quiet" title="心跳 ${acc.checks.heartbeat ? '✓' : '✗'} / 唤醒通道 ${acc.checks.channel ? '✓' : '✗'} / 点名闭环 ${acc.checks.loop ? '✓' : '✗'}（只看最近 ${acc.loopWindowHours || 24} 小时：只挂心跳、不会回应的成员会降级）">验收 ${acc.passed}/3</span>`;
      // 引擎：把点名变成回复的那一层（rules/agent-runner 自报）。
      // 显示它是为了让"这个成员背后是什么实现、谁是真人在回"一眼可见，
      // 也提醒一件事：核心不认识厂商，换引擎不影响黑板通信。
      const ENGINE_LABELS = {
        'rule-based': '规则引擎',
        command: '本地命令',
        'openai-compatible': 'OpenAI 兼容接口',
        'codex-cli': 'Codex CLI',
        'codex-app-server': 'Codex 常驻通道',
        sentinel: '自动巡检',
        human: '人工回复',
      };
      const engineBadge = agent.engine
        ? `<span class="pending pending--quiet" title="引擎：${esc(agent.engine)} —— 把点名变成回复的那一层；核心与引擎解耦，换引擎不影响通信">${esc(
            ENGINE_LABELS[agent.engine] || agent.engine,
          )}</span>`
        : '';
      return `
      <li class="member" data-state="${esc(agent.state)}" data-contract="${esc(contract ? contract.state : '')}" data-agent="${esc(agent.id)}">
        <span class="member__mono${agent.avatar ? ' member__mono--img' : ''}">${
          agent.avatar
            ? `<img class="mono__img" src="${esc(agent.avatar)}" alt="${esc(agent.name)}" />`
            : esc(agent.monogram)
        }</span>
        <span class="member__main">
          <span class="member__name">${esc(agent.name)}</span>
          <span class="member__sub${contractClass}" title="${esc(
            [contract ? contract.detail : '', agent.platform || ''].filter(Boolean).join('　|　'),
          )}">${esc(sub)}</span>
        </span>
        <span class="member__badges">
          ${accBadge}
          ${engineBadge}
          ${modeBadge}
          ${pendingBadge}
          ${queuedBadge}
          ${expiredBadge}
          ${repliedBadge}
          ${undeclared}
          ${
            agent.contract && agent.contract.severity === 'alert' && agent.contract.messageId
              ? `<button class="member__interrupt" type="button" data-requeue="${esc(agent.id)}:${esc(agent.contract.messageId)}" title="契约已违约（${esc(
                  agent.contract.label,
                )}）：让这条点名重新走一遍投递">重新派发</button>`
              : ''
          }
          ${
            agent.openDeliveries
              ? `<button class="member__interrupt" type="button" data-interrupt="${esc(agent.id)}" title="打断它正在进行的任务（${
                  agent.openDeliveries
                } 条投递未完成）">打断</button>`
              : ''
          }
        </span>
      </li>`;
    })
    .join('');

  el.rosterEmpty.hidden = state.agents.length > 0;
  // 契约违约（severity=alert）的成员数：面板头部的"正常 N"比"在线 N"更接近项目目标。
  // 没有待办的成员算正常——"暂时没活"不是失职，只有违约才该被点出来。
  const breached = state.agents.filter((agent) => agent.contract && agent.contract.severity === 'alert');
  el.onlineCount.textContent = `${state.agents.length - breached.length}/${state.agents.length}`;
  el.onlineCount.title = `正常履行契约的成员 / 全部成员（心跳在线 ${state.presence.online}/${state.presence.total}，仅作参考）`;
  const latest = state.messages[state.messages.length - 1];
  const counts = (state.deliverySummary && state.deliverySummary.counts) || {};
  const pendingDelivery = (counts.queued || 0) + (counts.delivered || 0) + (counts.working || 0);
  el.railMeta.innerHTML = [
    `留言 ${state.stats ? state.stats.total : state.messages.length} 条`,
    latest ? `最新 ${esc(clockOf(latest.ts))}` : '',
    `投递中 ${pendingDelivery}`,
    // 契约违约数（没取件 / 没回执 / 没交付）：面板要能一眼看出"有人没在履行"
    breached.length ? `<span class="rail__alert">未履行 ${breached.length}</span>` : '',
    counts.expired ? `超时未回 ${counts.expired}` : '',
    `在线判定 ${state.presence.ttlSeconds}s`,
  ]
    .filter(Boolean)
    .join(' · ');
}

function renderTopicOptions() {
  const topics = state.topics.map((topic) => topic.topic);
  el.topicOptions.innerHTML = topics.map((topic) => `<option value="${esc(topic)}"></option>`).join('');
  const current = el.topicFilter.value;
  el.topicFilter.innerHTML =
    '<option value="">全部</option>' + topics.map((topic) => `<option value="${esc(topic)}">${esc(topic)}</option>`).join('');
  el.topicFilter.value = topics.includes(current) ? current : '';
}

function renderBoardSub() {
  const latest = state.messages[state.messages.length - 1];
  if (!latest) {
    el.boardSub.textContent = '暂无留言 —— 黑板始终显示最新的一条信息';
    return;
  }
  const snippet = latest.text.replace(/\s+/g, ' ').slice(0, 46);
  el.boardSub.innerHTML = `最新 · ${esc(latest.agentName)}：${esc(snippet)}${
    latest.text.length > 46 ? '…' : ''
  }（${esc(clockOf(latest.ts))}）`;
}

function renderAll({ animateLast = false } = {}) {
  renderStream({ animateLast });
  renderRoster();
  renderTopicOptions();
  renderBoardSub();
}

/* ── 跟随最新 ─────────────────────────────────────────────── */

function distanceFromBottom() {
  return el.stream.scrollHeight - el.stream.scrollTop - el.stream.clientHeight;
}

function scrollToNewest({ smooth = true } = {}) {
  el.stream.scrollTo({ top: el.stream.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  state.following = true;
  state.newCount = 0;
  el.toNewest.hidden = true;
}

function onNewMessage(message) {
  state.messages.push(message);
  if (state.messages.length > 2000) state.messages.splice(0, state.messages.length - 2000);
  // 必须同步 seenSeq：否则下一次 15 秒 ping 会误判"漏了消息"而全量刷新，
  // 造成多余重渲染并可能打断阅读位置。
  if (typeof message.seq === 'number' && message.seq > state.seenSeq) state.seenSeq = message.seq;
  const shouldFollow = state.following || distanceFromBottom() < 90;
  appendMessage(message);
  renderBoardSub();
  if (shouldFollow) {
    scrollToNewest({ smooth: true });
  } else {
    state.following = false;
    state.newCount += 1;
    el.newCount.textContent = String(state.newCount);
    el.toNewest.hidden = false;
  }
}

/* ── 数据同步 ─────────────────────────────────────────────── */

/** 前端资源被更新过就自动刷新：避免一直看着旧界面（例如换了 logo 却看不到）。 */
function checkAssetsVersion(incoming) {
  if (!incoming) return;
  if (!state.assets) {
    state.assets = incoming;
    return;
  }
  if (incoming !== state.assets) {
    state.assets = incoming;
    location.reload();
  }
}

function applyState(payload, { animateLast = false } = {}) {
  checkAssetsVersion(payload.assets);
  state.instanceId = (payload.board && payload.board.instanceId) || state.instanceId;
  state.agents = payload.agents || [];
  state.topics = payload.topics || [];
  state.pending = payload.pending || [];
  state.presence = payload.presence || state.presence;
  state.stats = payload.stats || null;
  state.messages = payload.messages || [];
  state.wakeQueue = payload.wakeQueue || {};
  state.deliverySummary = payload.deliverySummary || {};
  state.avatars = payload.avatars || {};
  state.localId = (payload.board && payload.board.localAgentId) || 'local';
  state.seenSeq = state.messages.reduce((max, msg) => Math.max(max, msg.seq), 0);
  renderAll({ animateLast });
}

/** 服务端换了实例（重启/换端口）→ 旧投影一律作废，强制全量重同步。 */
function noteInstance(payload) {
  const incoming = payload && payload.instanceId;
  if (!incoming) return false;
  if (!state.instanceId) {
    state.instanceId = incoming;
    return false;
  }
  if (state.instanceId !== incoming) {
    state.instanceId = incoming;
    // 清掉"已渲染序号"，让下一次 refresh 必然走全量分支
    state.seenSeq = -1;
    toast('服务已重启，正在重新同步…');
    refresh();
    return true;
  }
  return false;
}

async function refresh({ quiet = true } = {}) {
  try {
    // 带回游标：服务端按 seq > since 过滤，因此断线期间哪怕新增超过 300 条，
    // 也能完整补回（旧的固定 limit=300 只取末尾 300 条，中间会永久缺号）。
    const since = state.seenSeq > 0 ? state.seenSeq : 0;
    const payload = await api(`/api/state?limit=300${since ? `&since=${since}` : ''}`);
    const incoming = payload.messages || [];
    const instance = (payload.board && payload.board.instanceId) || null;
    if (instance && state.instanceId && instance !== state.instanceId) {
      state.instanceId = instance;
      // 换实例：增量游标可能对不上，强制全量
      const full = await api('/api/state?limit=300');
      applyState(full, { animateLast: true });
      toast('服务已重启，已重新同步');
      return;
    }
    state.instanceId = instance || state.instanceId;

    if (since > 0) {
      // 增量补拉：**分页取到取完为止**。
      // 服务端 since>0 时返回"since 之后最早的 N 条"，因此只要还有整页就往后续游标继续取；
      // 断线期间哪怕新增上千条也不会中间缺号（旧的固定单次 limit=300 会永久跳过中间部分）。
      const batch = 300;
      let cursor = since;
      let page = payload;
      const collected = [];
      let lastPage = payload;
      for (let round = 0; round < 100; round += 1) {
        const list = page.messages || [];
        lastPage = page;
        if (!list.length) break;
        collected.push(...list);
        cursor = list[list.length - 1].seq;
        if (list.length < batch) break;
        page = await api(`/api/state?limit=${batch}&since=${cursor}`);
      }

      const known = new Set(state.messages.map((msg) => msg.seq));
      const added = collected.filter((msg) => !known.has(msg.seq)).sort((a, b) => a.seq - b.seq);
      if (added.length) {
        const shouldFollow = state.following || distanceFromBottom() < 90;
        state.messages = [...state.messages, ...added];
        if (state.messages.length > 5000) state.messages.splice(0, state.messages.length - 5000);
        state.seenSeq = Math.max(state.seenSeq, ...added.map((msg) => msg.seq));
        for (const message of added) appendMessage(message);
        if (shouldFollow) scrollToNewest({ smooth: false });
      }
      // 其余投影照常同步（投递/唤醒/议题/头像/成员），以最后一页为准
      syncSideData(lastPage);
      return;
    }

    const incomingLatest = incoming.reduce((max, msg) => Math.max(max, msg.seq), 0);
    if (incomingLatest !== state.seenSeq) {
      const previousCount = state.messages.length;
      applyState(payload, { animateLast: previousCount > 0 });
      if (state.following) scrollToNewest({ smooth: false });
      return;
    }
    syncSideData(payload, { withMessages: true });
  } catch (error) {
    if (!quiet) toast(`读取黑板失败：${error.message}`);
  }
}

/**
 * 同步"侧栏/统计/投影"这一类字段。
 * withMessages=true 时也把留言的 delivery/wake 投影写回（SSE 是就地改徽标的，
 * 若 state.messages 不同步，下一次全量渲染会把徽标覆盖回旧值）。
 */
function syncSideData(payload, { withMessages = false } = {}) {
  state.agents = payload.agents || state.agents;
  state.pending = payload.pending || state.pending;
  state.presence = payload.presence || state.presence;
  state.stats = payload.stats || state.stats;
  state.deliverySummary = payload.deliverySummary || state.deliverySummary;
  state.wakeQueue = payload.wakeQueue || state.wakeQueue;
  state.topics = payload.topics || state.topics;
  state.avatars = payload.avatars || state.avatars;
  if (withMessages && payload.messages) state.messages = payload.messages;
  renderRoster();
  renderBoardSub();
  renderRailMeta();
  syncMessageChips();
}

function setConnection(status) {
  el.conn.dataset.state = status;
  el.conn.querySelector('.conn__text').textContent =
    { open: '已连接 · 实时', connecting: '正在连接…', closed: '连接断开 · 重试中' }[status] || status;
}

function subscribe() {
  const source = new EventSource(withToken('/api/stream'));
  source.addEventListener('open', () => {
    setConnection('open');
    // 断线期间黑板可能新增了留言：重连后立刻补拉一次
    refresh();
  });
  source.addEventListener('hello', (event) => {
    setConnection('open');
    try {
      const payload = JSON.parse(event.data);
      checkAssetsVersion(payload.assets);
      // 服务换了实例（重启）→ 立刻全量重同步，别再用旧投影渲染
      noteInstance(payload);
    } catch {
      /* 忽略 */
    }
  });
  source.addEventListener('error', () => setConnection('closed'));
  // 服务端每 15 秒带一次 ping：既证明连接活着（比等 error 早得多），
  // 又能让页面发现"自己漏了消息"——序号对不上就立刻补拉，不再干等 30 秒轮询。
  source.addEventListener('ping', (event) => {
    setConnection('open');
    try {
      const payload = JSON.parse(event.data);
      if (typeof payload.latestSeq === 'number' && payload.latestSeq !== state.seenSeq) {
        refresh();
      }
    } catch {
      /* 忽略 */
    }
  });
  source.addEventListener('message', (event) => {
    try {
      onNewMessage(JSON.parse(event.data));
    } catch {
      /* 忽略无法解析的事件 */
    }
  });
  source.addEventListener('presence', (event) => {
    try {
      const payload = JSON.parse(event.data);
      state.agents = payload.agents || state.agents;
      state.presence = payload.presence || state.presence;
      renderRoster();
    } catch {
      /* 忽略 */
    }
  });
  source.addEventListener('wake', (event) => {
    try {
      applyWakeResult(JSON.parse(event.data));
    } catch {
      /* 忽略 */
    }
  });
  source.addEventListener('delivery', (event) => {
    try {
      applyDelivery(JSON.parse(event.data));
    } catch {
      /* 忽略 */
    }
  });
  setConnection('connecting');
}

/* ── 交互 ─────────────────────────────────────────────────── */

const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const PREVIEW_PLACEHOLDER = '填入成员 id 后，这里会显示将要复制的接入提示词。';

function joinDraft() {
  return {
    id: el.joinId.value.trim().toLowerCase(),
    name: el.joinName.value.trim(),
    title: el.joinJob.value.trim(),
    platform: el.joinPlatform.value.trim(),
    engine: el.joinEngine ? el.joinEngine.value.trim() : '',
  };
}

function promptUrlFor(draft) {
  const params = new URLSearchParams({
    agent: draft.id,
    name: draft.name,
    title: draft.title,
    platform: draft.platform,
    engine: draft.engine,
  });
  return withToken(`/api/prompt?${params.toString()}`);
}

let previewToken = 0;

/** 表单变化时预览提示词；只有 id 合法时才请求服务端。 */
async function updatePreview() {
  const draft = joinDraft();
  if (!AGENT_ID_RE.test(draft.id)) {
    el.joinPreview.textContent = draft.id
      ? '成员 id 只能用小写字母、数字、下划线或短横线（2–32 位），且以字母或数字开头。'
      : PREVIEW_PLACEHOLDER;
    return;
  }
  const token = ++previewToken;
  try {
    const text = await (await fetch(promptUrlFor(draft))).text();
    if (token !== previewToken) return;
    el.joinPreview.textContent = text;
  } catch (error) {
    if (token !== previewToken) return;
    el.joinPreview.textContent = `生成提示词失败：${error.message}`;
  }
}

function openJoinModal() {
  el.joinModal.hidden = false;
  if (!el.joinPreview.textContent || el.joinPreview.textContent === '') el.joinPreview.textContent = PREVIEW_PLACEHOLDER;
  updatePreview();
  el.joinId.focus();
  el.joinId.select();
}

function closeJoinModal() {
  el.joinModal.hidden = true;
}

/* ── 设置助手：填 Key → 一键换真 AI ──────────────────────── */

async function openSettingsModal() {
  el.settingsModal.hidden = false;
  el.settingsSave.disabled = true;
  try {
    const current = await api('/api/assistant/setup');
    el.settingsModel.value = current.model || 'deepseek-chat';
    el.settingsBaseUrl.value = '';
    el.settingsKey.value = '';
    el.settingsKey.placeholder = current.hasKey ? `已保存 ${current.maskedKey}（留空则清除）` : 'sk-…';
    el.settingsSub.textContent = current.hasKey
      ? `助手当前用的是真 AI（引擎 ${current.engine}）。留空 Key 并保存可换回规则应答。`
      : '内置助手现在用本地规则应答。填一个 API Key，它就能真正回答你的问题。';
  } catch (error) {
    el.settingsSub.textContent = `读取当前设置失败：${error.message}`;
  }
  el.settingsSave.disabled = false;
  el.settingsKey.focus();
}

function closeSettingsModal() {
  el.settingsModal.hidden = true;
}

async function saveAssistantSettings() {
  el.settingsSave.disabled = true;
  try {
    const body = {
      apiKey: el.settingsKey.value.trim(),
      model: el.settingsModel.value.trim() || 'deepseek-chat',
      baseUrl: el.settingsBaseUrl.value.trim(),
    };
    const result = await api('/api/assistant/setup', { method: 'POST', body: JSON.stringify(body) });
    toast(result.hint || '已保存');
    closeSettingsModal();
    refresh();
  } catch (error) {
    toast(`保存失败：${error.message}`);
  } finally {
    el.settingsSave.disabled = false;
  }
}

async function copyJoinPrompt() {
  const draft = joinDraft();
  if (!AGENT_ID_RE.test(draft.id)) {
    toast('请先填写合法的成员 id（小写英文，2–32 位）');
    el.joinId.focus();
    return;
  }
  el.joinCopy.disabled = true;
  const label = el.joinCopy.textContent;
  el.joinCopy.textContent = '复制中…';
  try {
    const text = await (await fetch(promptUrlFor(draft))).text();
    const ok = await copyText(text);
    toast(
      ok
        ? `已复制「${draft.name || draft.id}」的接入提示词 —— 发给它即可加入黑板`
        : '复制失败，请在预览框里手动全选复制',
    );
    el.joinCopy.textContent = ok ? '已复制 ✓' : label;
    setTimeout(() => {
      el.joinCopy.textContent = label;
    }, 2000);
  } catch (error) {
    toast(`获取提示词失败：${error.message}`);
    el.joinCopy.textContent = label;
  } finally {
    el.joinCopy.disabled = false;
  }
}

async function sendMessage(event) {
  event.preventDefault();
  const text = el.composerText.value.trim();
  if (!text) {
    el.composerHint.textContent = '留言不能为空';
    return;
  }
  el.send.disabled = true;
  el.composerHint.textContent = '发送中…';
  try {
    const payload = await api('/api/message', {
      method: 'POST',
      body: JSON.stringify({
        agent: state.localId,
        text,
        topic: el.composerTopic.value.trim() || null,
        status: el.composerStatus.value || null,
        kind: 'message',
      }),
    });
    el.composerText.value = '';
    el.composerHint.textContent = '';
    closeMentions();

    // 点名即唤醒：立刻把结果告诉留言的人
    const wakes = payload.wakes || [];
    const woken = wakes.filter((item) => item.ok && item.channel !== 'queued').map((item) => `@${item.agent}`);
    const queued = wakes.filter((item) => item.channel === 'queued').map((item) => `@${item.agent}`);
    if (woken.length || queued.length) {
      const parts = [];
      if (woken.length) parts.push(`已立刻唤醒 ${woken.join('、')}`);
      if (queued.length) parts.push(`${queued.join('、')} 没有监听通道，已入队待唤醒`);
      toast(parts.join('；'));
    }
    if (payload.warnings && payload.warnings.length) toast(payload.warnings[0]);
    refresh();
  } catch (error) {
    el.composerHint.textContent = '';
    toast(error.message);
  } finally {
    el.send.disabled = false;
  }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('mb-theme', theme);
  // 在桌面外壳（WPF + WebView2）里运行时，把主题告诉外壳，让无边框标题栏跟着变色
  try {
    window.chrome?.webview?.postMessage(JSON.stringify({ type: 'theme', theme }));
  } catch {
    /* 普通浏览器里没有 chrome.webview，忽略 */
  }
}

function initTheme() {
  const forced = new URLSearchParams(location.search).get('theme');
  if (forced === 'dark' || forced === 'light') {
    applyTheme(forced);
    return;
  }
  const saved = localStorage.getItem('mb-theme');
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(saved || (prefersDark ? 'dark' : 'light'));
}

/* ── 点名列表（输入 @ 浮出成员）───────────────────────────── */

const ONLINE_STATES = new Set(['online', 'busy', 'idle']);
const mention = { open: false, items: [], index: 0, start: 0, end: 0 };
const PREVIEW = /[\s\u3000(（[【"'“”]|^$/;

/** 找出光标前正在输入的 @片段；不在 @片段里则返回 null。 */
function mentionContext() {
  const value = el.composerText.value;
  const caret = el.composerText.selectionStart ?? value.length;
  const before = value.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at === -1) return null;
  const fragment = before.slice(at + 1);
  if (/[\s@]/.test(fragment)) return null; // 已经断开，不在点名里
  if (!PREVIEW.test(before.slice(0, at))) return null; // @ 前面必须是空白/行首/左括号
  return { query: fragment.toLowerCase(), start: at, end: caret };
}

function closeMentions() {
  if (!mention.open) return;
  mention.open = false;
  el.mentionList.hidden = true;
}

/** 在线成员优先，其次离线；都按接入顺序。 */
function mentionCandidates(query) {
  return state.agents
    .filter((agent) => agent.kind !== 'operator')
    .filter(
      (agent) =>
        !query ||
        agent.id.startsWith(query) ||
        String(agent.name).toLowerCase().includes(query),
    )
    .sort((a, b) => Number(ONLINE_STATES.has(b.state)) - Number(ONLINE_STATES.has(a.state)));
}

function renderMentions() {
  if (!mention.items.length) {
    el.mentionList.innerHTML = `<li class="mentions__empty">${
      state.agents.length ? '没有匹配的成员' : '还没有成员接入 —— 先点「接入新成员」'
    }</li>`;
  } else {
    el.mentionList.innerHTML = mention.items
      .map(
        (agent, index) => `
      <li class="mention__item ${index === mention.index ? 'is-active' : ''}" data-index="${index}"
          role="option" aria-selected="${index === mention.index}">
        <span class="member__mono mention__mono">${esc(agent.monogram)}</span>
        <span class="mention__main">
          <span class="mention__name">${esc(agent.name)}</span>
          <span class="mention__id">@${esc(agent.id)}</span>
        </span>
        <span class="mention__state" data-state="${esc(agent.state)}">${esc(STATE_LABEL[agent.state] || agent.state)}</span>
      </li>`,
      )
      .join('');
  }
  el.mentionList.hidden = false;
}

function openMentions() {
  const context = mentionContext();
  if (!context) return closeMentions();
  const items = mentionCandidates(context.query);
  mention.open = true;
  mention.items = items;
  mention.index = 0;
  mention.start = context.start;
  mention.end = context.end;
  renderMentions();
}

function moveMention(step) {
  if (!mention.items.length) return;
  const total = mention.items.length;
  mention.index = (mention.index + step + total) % total;
  renderMentions();
}

function insertMention(agent) {
  const value = el.composerText.value;
  const before = value.slice(0, mention.start);
  const after = value.slice(mention.end);
  el.composerText.value = `${before}@${agent.id} ${after}`;
  const caret = before.length + agent.id.length + 2;
  el.composerText.focus();
  el.composerText.setSelectionRange(caret, caret);
  closeMentions();
}

function onComposerKeydown(event) {
  if (!mention.open) return;
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    moveMention(1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    moveMention(-1);
  } else if ((event.key === 'Enter' || event.key === 'Tab') && mention.items.length) {
    event.preventDefault();
    insertMention(mention.items[mention.index]);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeMentions();
  }
}

function bind() {
  el.theme.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });

  el.stream.addEventListener('scroll', () => {
    const near = distanceFromBottom() < 90;
    if (near) {
      state.following = true;
      state.newCount = 0;
      el.toNewest.hidden = true;
    }
  });

  el.toNewest.addEventListener('click', () => scrollToNewest({ smooth: true }));

  el.topicFilter.addEventListener('change', () => {
    state.filter = el.topicFilter.value;
    renderStream({ animateLast: false });
    if (state.following) scrollToNewest({ smooth: false });
  });

  el.join.addEventListener('click', openJoinModal);
  el.joinClose.addEventListener('click', closeJoinModal);
  el.joinCopy.addEventListener('click', copyJoinPrompt);
  el.settingsButton.addEventListener('click', openSettingsModal);
  el.settingsClose.addEventListener('click', closeSettingsModal);
  el.settingsSave.addEventListener('click', saveAssistantSettings);
  for (const field of [el.joinId, el.joinName, el.joinJob, el.joinPlatform, el.joinEngine]) {
    if (field) field.addEventListener('input', updatePreview);
  }
  el.joinModal.addEventListener('click', (event) => {
    if (event.target === el.joinModal) closeJoinModal();
  });
  el.settingsModal.addEventListener('click', (event) => {
    if (event.target === el.settingsModal) closeSettingsModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !el.joinModal.hidden) closeJoinModal();
    if (event.key === 'Escape' && !el.settingsModal.hidden) closeSettingsModal();
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && document.activeElement === el.composerText) {
      el.composer.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  });

  el.composer.addEventListener('submit', sendMessage);

  // AI 长回复的折叠/展开：结论在前，点开看全文
  el.stream.addEventListener('click', (event) => {
    const button = event.target.closest('.msg__expand');
    if (!button) return;
    const wrap = button.closest('[data-collapsible]');
    if (!wrap) return;
    const full = wrap.querySelector('.msg__full');
    const summary = wrap.querySelector('.msg__summary');
    const opening = full.hidden;
    full.hidden = !opening;
    summary.hidden = opening;
    button.textContent = opening ? '收起' : '展开全文';
    button.setAttribute('aria-expanded', String(opening));
  });

  // 窄窗：侧栏整体折叠成抽屉（宽窗下这些样式不生效，等同于一直显示）
  const shellEl = document.querySelector('.shell');
  const railToggle = document.getElementById('railToggle');
  const railBackdrop = document.getElementById('railBackdrop');
  const setRailOpen = (open) => {
    if (!shellEl) return;
    shellEl.classList.toggle('shell--rail-open', open);
    if (railBackdrop) railBackdrop.hidden = !open;
  };
  railToggle?.addEventListener('click', () => setRailOpen(!shellEl.classList.contains('shell--rail-open')));
  railBackdrop?.addEventListener('click', () => setRailOpen(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setRailOpen(false);
  });
  // 窗口变宽后抽屉状态自动失效（媒体查询不再命中），把标记与遮罩一并清掉
  window.addEventListener('resize', () => {
    if (window.innerWidth > 1000) setRailOpen(false);
  });
  // 深链：?rail=open 直接展开成员抽屉（窄窗下有用，也便于截图核对）
  if (new URLSearchParams(location.search).get('rail') === 'open') setRailOpen(true);

  // 右下角拖拽角标：只在桌面外壳里出现（WebView2 提供 chrome.webview）。
  // 拖拽量按**增量**发给外壳，由外壳改窗口尺寸；浏览器里保持隐藏（网页无权改浏览器窗口）。
  const grip = document.getElementById('resizeGrip');
  const webview = window.chrome?.webview;
  if (grip && webview) {
    grip.hidden = false;
    let lastX = 0;
    let lastY = 0;
    const pending = { dx: 0, dy: 0, scheduled: false };
    const flush = () => {
      pending.scheduled = false;
      if (!pending.dx && !pending.dy) return;
      const dx = pending.dx;
      const dy = pending.dy;
      pending.dx = 0;
      pending.dy = 0;
      try {
        webview.postMessage(JSON.stringify({ type: 'resize', dx, dy }));
      } catch {
        /* 外壳未处理时忽略 */
      }
    };
    grip.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      grip.setPointerCapture(event.pointerId);
      lastX = event.clientX;
      lastY = event.clientY;
      document.body.classList.add('is-resizing');
    });
    grip.addEventListener('pointermove', (event) => {
      if (!grip.hasPointerCapture(event.pointerId)) return;
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      if (!dx && !dy) return;
      lastX = event.clientX;
      lastY = event.clientY;
      // 累积到下一帧再发，避免每个 pointermove 都跨进程通信
      pending.dx += dx;
      pending.dy += dy;
      if (!pending.scheduled) {
        pending.scheduled = true;
        requestAnimationFrame(flush);
      }
    });
    const endDrag = (event) => {
      try {
        grip.releasePointerCapture(event.pointerId);
      } catch {
        /* 忽略 */
      }
      flush();
      document.body.classList.remove('is-resizing');
    };
    grip.addEventListener('pointerup', endDrag);
    grip.addEventListener('pointercancel', endDrag);
  }

  // 打断：向成员发出控制指令，由它自己的通道执行 turn/interrupt
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-interrupt]');
    if (!button) return;
    const agentId = button.dataset.interrupt;
    if (!window.confirm(`打断 @${agentId} 正在进行的任务？`)) return;
    button.disabled = true;
    api('/api/interrupt', {
      method: 'POST',
      body: JSON.stringify({ agent: agentId, reason: '人类在黑板界面上打断' }),
    })
      .then((result) => {
        toast(`已向 @${agentId} 发出打断指令（inbox 队列 ${result.queueDepth}）`);
        refresh();
      })
      .catch((error) => toast(`打断失败：${error.message}`))
      .finally(() => {
        button.disabled = false;
      });
  });

  // 重新派发：契约违约后，让这一条点名重新走一遍投递（人可确认的补救动作）
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-requeue]');
    if (!button) return;
    const [agentId, messageId] = button.dataset.requeue.split(':');
    if (!window.confirm(`重新派发 @${agentId} 的这条点名？哨兵也会在违约时自动接管，这里是手动先走一步。`)) return;
    button.disabled = true;
    api('/api/requeue', {
      method: 'POST',
      body: JSON.stringify({ agent: agentId, messageId }),
    })
      .then((result) => {
        toast(result.note || `已重新派发 @${agentId}`);
        refresh();
      })
      .catch((error) => toast(`重新派发失败：${error.message}`))
      .finally(() => {
        button.disabled = false;
      });
  });

  // 输入 @ 时浮出成员列表
  el.composerText.addEventListener('input', openMentions);
  el.composerText.addEventListener('click', openMentions);
  el.composerText.addEventListener('keydown', onComposerKeydown);
  el.composerText.addEventListener('blur', () => setTimeout(closeMentions, 150));
  el.mentionList.addEventListener('mousedown', (event) => {
    const item = event.target.closest('[data-index]');
    if (!item) return;
    event.preventDefault(); // 避免 blur 先于点击生效
    insertMention(mention.items[Number(item.dataset.index)]);
  });
}

/* ── 启动 ─────────────────────────────────────────────────── */

(async function boot() {
  initTheme();
  bind();
  await refresh({ quiet: false });
  scrollToNewest({ smooth: false });
  const params = new URLSearchParams(location.search);
  if (params.has('nostream')) {
    // 静默模式（截图 / 静态预览）：不建立 SSE，也不谎报「已连接」。
    el.conn.dataset.state = 'closed';
    el.conn.querySelector('.conn__text').textContent = '静态预览 · 未连接实时流';
  } else {
    subscribe();
  }
  // ?join=1：直接打开「快速接入」面板，便于把接入入口作为链接发给同伴。
  if (params.has('join')) openJoinModal();
  // ?compose=@ ：预填留言内容（截图 / 演示用），并直接展开点名列表。
  const compose = params.get('compose');
  if (compose !== null) {
    el.composerText.value = compose;
    openMentions();
  }
  setInterval(() => refresh(), 30000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
})();
