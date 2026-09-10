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
  joinPreview: $('joinPreview'),
  joinCopy: $('joinCopy'),
  composer: $('composer'),
  composerText: $('composerText'),
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
  localId: 'local',
  following: true,
  newCount: 0,
  filter: '',
  seenSeq: 0,
};

const STATE_LABEL = {
  online: '在线',
  busy: '忙碌',
  idle: '空闲',
  stale: '心跳超时',
  offline: '离线',
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

  article.innerHTML = `
    <div class="msg__mono">${esc(agent ? agent.monogram : '?')}</div>
    <div class="msg__body">
      <div class="msg__meta">
        <span class="msg__who">${esc(message.agentName || message.agent)}</span>
        <span class="msg__role">${esc(message.agentTitle || (agent ? agent.title : ''))}</span>
        <time class="msg__time" title="${esc(message.ts)}">${esc(clockOf(message.ts))}</time>
        ${chips.join('')}
        <span class="chip chip--latest" data-role="latest" hidden>最新</span>
      </div>
      <p class="msg__text">${linkifyMentions(esc(message.text))}</p>
      ${mentions}
    </div>`;
  return article;
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
      const sub = [agent.title, STATE_LABEL[agent.state] || agent.state, agoOf(agent.ageSeconds)]
        .filter(Boolean)
        .join(' · ');
      const undeclared = agent.selfDeclared
        ? ''
        : '<span class="pending pending--quiet" title="只发过心跳或发言，尚未自述身份">未自述</span>';
      return `
      <li class="member" data-state="${esc(agent.state)}" data-agent="${esc(agent.id)}">
        <span class="member__mono">${esc(agent.monogram)}</span>
        <span class="member__main">
          <span class="member__name">${esc(agent.name)}</span>
          <span class="member__sub" title="${esc(agent.platform || '')}">${esc(sub)}</span>
        </span>
        <span class="member__badges">
          ${pending ? `<span class="pending" title="被点名但尚无实质回复">待回应 ${pending}</span>` : ''}
          ${undeclared}
        </span>
      </li>`;
    })
    .join('');

  el.rosterEmpty.hidden = state.agents.length > 0;
  el.onlineCount.textContent = `${state.presence.online}/${state.presence.total}`;
  const latest = state.messages[state.messages.length - 1];
  el.railMeta.innerHTML = [
    `留言 ${state.stats ? state.stats.total : state.messages.length} 条`,
    latest ? `最新 ${esc(clockOf(latest.ts))}` : '',
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

function applyState(payload, { animateLast = false } = {}) {
  state.agents = payload.agents || [];
  state.topics = payload.topics || [];
  state.pending = payload.pending || [];
  state.presence = payload.presence || state.presence;
  state.stats = payload.stats || null;
  state.messages = payload.messages || [];
  state.localId = (payload.board && payload.board.localAgentId) || 'local';
  state.seenSeq = state.messages.reduce((max, msg) => Math.max(max, msg.seq), 0);
  renderAll({ animateLast });
}

async function refresh({ quiet = true } = {}) {
  try {
    const payload = await api('/api/state?limit=300');
    const incomingLatest = (payload.messages || []).reduce((max, msg) => Math.max(max, msg.seq), 0);
    if (incomingLatest !== state.seenSeq) {
      const previousCount = state.messages.length;
      applyState(payload, { animateLast: previousCount > 0 });
      if (state.following) scrollToNewest({ smooth: false });
      return;
    }
    // 消息没变（心跳/待回应可能变了）：只刷新侧栏与页眉，避免打断阅读。
    state.agents = payload.agents || state.agents;
    state.pending = payload.pending || state.pending;
    state.presence = payload.presence || state.presence;
    state.stats = payload.stats || state.stats;
    renderRoster();
    renderBoardSub();
  } catch (error) {
    if (!quiet) toast(`读取黑板失败：${error.message}`);
  }
}

function setConnection(status) {
  el.conn.dataset.state = status;
  el.conn.querySelector('.conn__text').textContent =
    { open: '已连接 · 实时', connecting: '正在连接…', closed: '连接断开 · 重试中' }[status] || status;
}

function subscribe() {
  const source = new EventSource(withToken('/api/stream'));
  source.addEventListener('open', () => setConnection('open'));
  source.addEventListener('hello', () => setConnection('open'));
  source.addEventListener('error', () => setConnection('closed'));
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
  };
}

function promptUrlFor(draft) {
  const params = new URLSearchParams({
    agent: draft.id,
    name: draft.name,
    title: draft.title,
    platform: draft.platform,
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
  for (const field of [el.joinId, el.joinName, el.joinJob, el.joinPlatform]) {
    field.addEventListener('input', updatePreview);
  }
  el.joinModal.addEventListener('click', (event) => {
    if (event.target === el.joinModal) closeJoinModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !el.joinModal.hidden) closeJoinModal();
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && document.activeElement === el.composerText) {
      el.composer.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  });

  el.composer.addEventListener('submit', sendMessage);
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
  setInterval(() => refresh(), 30000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
})();
