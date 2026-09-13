// Message Board · 前端
//
// 一个本地面板：左边是"项目 + 团队"，右边是当前面板（部门 / 项目 / 员工三种模式）。
// 零依赖，原生 ES module。

const APP_NAME = 'Message Board';

/* ── 小工具 ───────────────────────────────────────────── */

const $ = (id) => document.getElementById(id);

const el = {
  themeToggle: $('themeToggle'),
  projectList: $('projectList'),
  teamTree: $('teamTree'),
  newProject: $('newProject'),
  newDepartment: $('newDepartment'),
  openSettings: $('openSettings'),
  modeBadge: $('modeBadge'),
  panelTitle: $('panelTitle'),
  panelSub: $('panelSub'),
  panelRoster: $('panelRoster'),
  stream: $('stream'),
  composer: $('composer'),
  composerInput: $('composerInput'),
  sendBtn: $('sendBtn'),
  modal: $('modal'),
  modalTitle: $('modalTitle'),
  modalBody: $('modalBody'),
  modalFoot: $('modalFoot'),
  modalClose: $('modalClose'),
  ctxmenu: $('ctxmenu'),
  onboard: $('onboard'),
  toast: $('toast'),
};

const state = {
  settings: { hasKey: false, baseUrl: '', model: '', onboarded: false },
  departments: [],
  employees: [],
  projects: [],
  busy: [],
  context: { mode: 'department', id: '' },
  messages: [],
  expanded: new Set(),
  onboardingStep: 0,
};

const MODE_LABEL = { department: '部门', project: '项目', employee: '员工' };
const LEVEL_LABEL = { manager: '部门经理', lead: '项目负责人', worker: '执行人员' };

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function toast(text) {
  el.toast.textContent = text;
  el.toast.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { el.toast.hidden = true; }, 2600);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) throw new Error(body.error || `请求失败（${response.status}）`);
  return body;
}

/* ── 随机头像：种子 → 颜色 + 首字（简单、零依赖）──────── */

function avatarHtml(name, seed, size = '') {
  const hue = Math.abs(Number(seed) || 0) % 360;
  const hue2 = (hue + 42) % 360;
  const ch = esc(String(name || '?').trim().slice(0, 1).toUpperCase());
  const cls = `avatar${size ? ` avatar--${size}` : ''}`;
  return `<span class="${cls}" style="background:linear-gradient(135deg,hsl(${hue} 58% 58%),hsl(${hue2} 54% 46%))">${ch}</span>`;
}

function employeeById(id) {
  return state.employees.find((item) => item.id === id) || null;
}
function departmentById(id) {
  return state.departments.find((item) => item.id === id) || null;
}
function projectById(id) {
  return state.projects.find((item) => item.id === id) || null;
}

/** 当前面板里应该出现哪些员工。 */
function employeesOfContext() {
  const { mode, id } = state.context;
  if (mode === 'department') return state.employees.filter((item) => item.departmentId === id);
  if (mode === 'project') {
    const project = projectById(id);
    if (!project) return [];
    const ids = new Set(project.employeeIds || []);
    // 项目成员 = 显式加入的 + 参与部门里的所有人
    for (const employee of state.employees) {
      if ((project.departmentIds || []).includes(employee.departmentId)) ids.add(employee.id);
    }
    return state.employees.filter((item) => ids.has(item.id));
  }
  return state.employees.filter((item) => item.id === id);
}

/* ── 左侧栏 ───────────────────────────────────────────── */

function renderSidebar() {
  // 项目
  if (!state.projects.length) {
    el.projectList.innerHTML = '<li class="tree__empty">还没有项目</li>';
  } else {
    el.projectList.innerHTML = state.projects.map((project) => {
      const active = state.context.mode === 'project' && state.context.id === project.id;
      return `<li>
        <button class="tree__row${active ? ' is-active' : ''}" data-kind="project" data-id="${esc(project.id)}">
          <span class="tree__caret is-leaf">·</span>
          <span class="tree__name">${esc(project.name)}</span>
          <span class="tree__hint">${esc(project.status || '')}</span>
        </button>
      </li>`;
    }).join('');
  }

  // 团队：部门 → 成员
  if (!state.departments.length && !state.employees.length) {
    el.teamTree.innerHTML = '<li class="tree__empty">还没有部门</li>';
    return;
  }
  const orphans = state.employees.filter((item) => !item.departmentId || !departmentById(item.departmentId));
  const rows = [];

  for (const department of state.departments) {
    const members = state.employees.filter((item) => item.departmentId === department.id);
    const open = state.expanded.has(department.id);
    const active = state.context.mode === 'department' && state.context.id === department.id;
    rows.push(`<li>
      <button class="tree__row${active ? ' is-active' : ''}" data-kind="department" data-id="${esc(department.id)}">
        <span class="tree__caret${open ? ' is-open' : ''}" data-toggle="${esc(department.id)}">▶</span>
        <span class="tree__name">${esc(department.name)}</span>
        <span class="tree__hint">${members.length}</span>
      </button>
      ${open ? `<ul class="tree__children">${members.length
        ? members.map((employee) => employeeRow(employee)).join('')
        : '<li class="tree__empty">还没有员工</li>'}</ul>` : ''}
    </li>`);
  }

  if (orphans.length) {
    rows.push(`<li>
      <button class="tree__row"><span class="tree__caret is-leaf">·</span><span class="tree__name">未分配部门</span></button>
      <ul class="tree__children">${orphans.map((employee) => employeeRow(employee)).join('')}</ul>
    </li>`);
  }

  el.teamTree.innerHTML = rows.join('');
}

function employeeRow(employee) {
  const active = state.context.mode === 'employee' && state.context.id === employee.id;
  const busy = state.busy.includes(employee.id);
  return `<li>
    <button class="tree__row${active ? ' is-active' : ''}" data-kind="employee" data-id="${esc(employee.id)}">
      ${avatarHtml(employee.name, employee.avatar?.seed, 'sm')}
      <span class="tree__name">${esc(employee.name)}</span>
      <span class="dot ${busy ? 'dot--busy' : ''}"></span>
    </button>
  </li>`;
}

/* ── 主面板 ───────────────────────────────────────────── */

function renderPanelHead() {
  const { mode, id } = state.context;
  el.modeBadge.textContent = MODE_LABEL[mode] || mode;
  const members = employeesOfContext();

  if (mode === 'department') {
    const department = departmentById(id);
    el.panelTitle.textContent = department ? department.name : '未选择部门';
    el.panelSub.textContent = department?.description || (department ? `${members.length} 位成员` : '在左侧选一个部门');
  } else if (mode === 'project') {
    const project = projectById(id);
    if (project) {
      const depts = (project.departmentIds || []).map((depId) => departmentById(depId)?.name).filter(Boolean);
      el.panelTitle.textContent = project.name;
      el.panelSub.textContent = [project.description, depts.length ? `参与部门：${depts.join('、')}` : '']
        .filter(Boolean).join(' · ');
    } else {
      el.panelTitle.textContent = '未选择项目';
      el.panelSub.textContent = '在左侧选一个项目';
    }
  } else {
    const employee = employeeById(id);
    if (employee) {
      const department = departmentById(employee.departmentId);
      el.panelTitle.textContent = employee.name;
      el.panelSub.textContent = [department?.name, employee.title, employee.model || '默认模型']
        .filter(Boolean).join(' · ');
    } else {
      el.panelTitle.textContent = '未选择员工';
      el.panelSub.textContent = '在左侧点一位成员';
    }
  }

  el.panelRoster.innerHTML = members.map((employee) => `
    <button class="roster__item" data-kind="employee" data-id="${esc(employee.id)}" title="${esc(employee.title)}">
      ${avatarHtml(employee.name, employee.avatar?.seed, 'sm')}
      <span>${esc(employee.name)}</span>
    </button>`).join('');
}

function renderStream() {
  if (!state.messages.length) {
    const { mode, id } = state.context;
    let hint = '这里还没有对话。在下面说点什么，或用 @名字 点名一位员工。';
    if (!id) hint = '先在左侧选一个部门、项目或员工。';
    else if (mode === 'employee') hint = '这是他的个人工作面板。直接说点什么，他就会开始干活。';
    el.stream.innerHTML = `<div class="stream__empty">${esc(hint)}</div>`;
    return;
  }

  el.stream.innerHTML = state.messages.map((message) => {
    const isLocal = message.from === 'local';
    const employee = isLocal ? null : employeeById(message.from);
    const seed = employee?.avatar?.seed ?? 0;
    const cls = [
      'msg',
      isLocal ? 'msg--local' : '',
      message.kind === 'ack' ? 'msg--ack' : '',
      message.kind === 'notice' && message.status === 'failed' ? 'msg--failed' : '',
    ].filter(Boolean).join(' ');
    const when = message.at ? new Date(message.at).toLocaleTimeString('zh-CN', { hour12: false }) : '';
    return `<article class="${cls}">
      ${isLocal ? '' : avatarHtml(message.fromName || '?', seed)}
      <div class="msg__body">
        <div class="msg__head">
          <span class="msg__who">${esc(message.fromName || message.from)}</span>
          <span class="msg__when">${esc(when)}</span>
        </div>
        <div class="msg__text">${esc(message.text)}</div>
        ${message.model && message.kind === 'reply' ? `<div class="msg__meta">模型：${esc(message.model)}</div>` : ''}
      </div>
    </article>`;
  }).join('');
  el.stream.scrollTop = el.stream.scrollHeight;
}

function renderAll() {
  renderSidebar();
  renderPanelHead();
  renderStream();
}

/* ── 加载 ─────────────────────────────────────────────── */

async function loadState() {
  const data = await api('/api/state');
  state.settings = data.settings;
  state.departments = data.departments;
  state.employees = data.employees;
  state.projects = data.projects;
  state.busy = data.busy || [];

  // 首次进入自动选一个面板
  if (!state.context.id) {
    const running = state.projects.find((item) => item.status === '进行中') || state.projects[0];
    if (running) state.context = { mode: 'project', id: running.id };
    else if (state.departments[0]) state.context = { mode: 'department', id: state.departments[0].id };
    else if (state.employees[0]) state.context = { mode: 'employee', id: state.employees[0].id };
  }
  // 当前上下文已被删除 → 回退
  const { mode, id } = state.context;
  const exists = (mode === 'department' && departmentById(id))
    || (mode === 'project' && projectById(id))
    || (mode === 'employee' && employeeById(id));
  if (id && !exists) state.context = { mode: 'department', id: state.departments[0]?.id || '' };

  renderAll();
  await loadThread();
  maybeShowOnboard();
}

async function loadThread() {
  const { mode, id } = state.context;
  if (!id) {
    state.messages = [];
    renderStream();
    return;
  }
  const data = await api(`/api/thread?mode=${encodeURIComponent(mode)}&id=${encodeURIComponent(id)}`);
  state.messages = data.messages;
  renderStream();
}

function switchContext(mode, id) {
  state.context = { mode, id };
  if (mode === 'department') state.expanded.add(id);
  renderAll();
  void loadThread();
}

/* ── 发消息 ───────────────────────────────────────────── */

async function send() {
  const text = el.composerInput.value.trim();
  const { mode, id } = state.context;
  if (!text || !id) return;
  el.sendBtn.disabled = true;
  try {
    await api('/api/message', { method: 'POST', body: JSON.stringify({ mode, threadId: id, text }) });
    el.composerInput.value = '';
    el.composerInput.style.height = 'auto';
  } catch (error) {
    toast(`发送失败：${error.message}`);
  } finally {
    el.sendBtn.disabled = false;
  }
}

/* ── 弹层 ─────────────────────────────────────────────── */

function openModal(title, bodyHtml, footHtml) {
  el.modalTitle.textContent = title;
  el.modalBody.innerHTML = bodyHtml;
  el.modalFoot.innerHTML = footHtml;
  el.modal.hidden = false;
  const first = el.modalBody.querySelector('input, textarea, select');
  if (first) first.focus();
}

function closeModal() {
  el.modal.hidden = true;
}

function departmentOptions(selectedId) {
  return state.departments.map((department) =>
    `<option value="${esc(department.id)}"${department.id === selectedId ? ' selected' : ''}>${esc(department.name)}</option>`,
  ).join('');
}

function levelOptions(selected) {
  return Object.entries(LEVEL_LABEL).map(([value, label]) =>
    `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`,
  ).join('');
}

/** 员工设置（新建或编辑） */
function openEmployeeModal(employee = null, presetDepartmentId = '') {
  const isNew = !employee;
  const data = employee || { name: '', title: '', level: 'worker', departmentId: presetDepartmentId, description: '', model: '', apiKey: '', baseUrl: '' };
  openModal(
    isNew ? '添加员工' : `设置 · ${employee.name}`,
    `<label class="field"><span class="field__label">名字</span>
       <input class="input" id="fName" value="${esc(data.name)}" placeholder="例如 李四" /></label>
     <div class="row2">
       <label class="field"><span class="field__label">职能</span>
         <input class="input" id="fTitle" value="${esc(data.title)}" placeholder="例如 后端工程师" /></label>
       <label class="field"><span class="field__label">层级</span>
         <select class="select" id="fLevel">${levelOptions(data.level)}</select></label>
     </div>
     <label class="field"><span class="field__label">所属部门</span>
       <select class="select" id="fDept"><option value="">（未分配）</option>${departmentOptions(data.departmentId)}</select></label>
     <label class="field"><span class="field__label">职责描述（会写进他的提示词）</span>
       <textarea class="textarea" id="fDesc" placeholder="他负责什么、擅长什么">${esc(data.description)}</textarea></label>
     <label class="field"><span class="field__label">模型（留空用全局默认）</span>
       <input class="input" id="fModel" value="${esc(data.model)}" placeholder="例如 deepseek-chat" /></label>
     <label class="field"><span class="field__label">API Key（留空用全局的）</span>
       <input class="input" id="fKey" type="password" value="" placeholder="${employee?.hasOwnKey ? '已单独设置（留空则保持不变）' : '留空 = 用全局 Key'}" autocomplete="off" /></label>
     <label class="field"><span class="field__label">接口地址（留空用全局的）</span>
       <input class="input" id="fBase" value="${esc(data.baseUrl)}" placeholder="https://api.deepseek.com" spellcheck="false" /></label>`,
    `<button class="ghost" id="modalCancel" type="button">取消</button>
     <button class="primary" id="modalSave" type="button">${isNew ? '添加' : '保存'}</button>`,
  );
  $('modalCancel').onclick = closeModal;
  $('modalSave').onclick = async () => {
    const name = $('fName').value.trim();
    if (!name) return toast('请填名字');
    const payload = {
      id: employee?.id,
      name,
      title: $('fTitle').value.trim() || '员工',
      level: $('fLevel').value,
      departmentId: $('fDept').value,
      description: $('fDesc').value.trim(),
      model: $('fModel').value.trim(),
      baseUrl: $('fBase').value.trim(),
    };
    const key = $('fKey').value.trim();
    if (key) payload.apiKey = key;
    try {
      await api('/api/employee', { method: 'POST', body: JSON.stringify(payload) });
      closeModal();
      toast(isNew ? `已添加 ${name}` : '已保存');
      await loadState();
    } catch (error) {
      toast(`保存失败：${error.message}`);
    }
  };
}

/** 部门设置 */
function openDepartmentModal(department = null) {
  const isNew = !department;
  const data = department || { name: '', description: '' };
  openModal(
    isNew ? '新建部门' : `设置 · ${department.name}`,
    `<label class="field"><span class="field__label">部门名字</span>
       <input class="input" id="fName" value="${esc(data.name)}" placeholder="例如 研发部" /></label>
     <label class="field"><span class="field__label">部门职责</span>
       <textarea class="textarea" id="fDesc" placeholder="这个部门负责什么">${esc(data.description)}</textarea></label>`,
    `<button class="ghost" id="modalCancel" type="button">取消</button>
     <button class="primary" id="modalSave" type="button">${isNew ? '创建' : '保存'}</button>`,
  );
  $('modalCancel').onclick = closeModal;
  $('modalSave').onclick = async () => {
    const name = $('fName').value.trim();
    if (!name) return toast('请填部门名字');
    try {
      const result = await api('/api/department', {
        method: 'POST',
        body: JSON.stringify({ id: department?.id, name, description: $('fDesc').value.trim() }),
      });
      closeModal();
      toast(isNew ? `已创建 ${name}` : '已保存');
      if (isNew) state.expanded.add(result.department.id);
      await loadState();
      if (isNew) switchContext('department', result.department.id);
    } catch (error) {
      toast(`保存失败：${error.message}`);
    }
  };
}

/** 项目设置 */
function openProjectModal(project = null) {
  const isNew = !project;
  const data = project || { name: '', description: '', status: '进行中', departmentIds: [] };
  const deptChecks = state.departments.map((department) => `
    <label class="field" style="display:flex;align-items:center;gap:8px;margin-bottom:7px">
      <input type="checkbox" value="${esc(department.id)}" ${(data.departmentIds || []).includes(department.id) ? 'checked' : ''} class="fDept" />
      <span>${esc(department.name)}</span>
    </label>`).join('') || '<p class="field__hint">还没有部门，先去「团队」里建一个</p>';
  openModal(
    isNew ? '新建项目' : `设置 · ${project.name}`,
    `<label class="field"><span class="field__label">项目名字</span>
       <input class="input" id="fName" value="${esc(data.name)}" placeholder="例如 官网改版" /></label>
     <label class="field"><span class="field__label">项目说明</span>
       <textarea class="textarea" id="fDesc" placeholder="这个项目要做什么">${esc(data.description)}</textarea></label>
     <label class="field"><span class="field__label">状态</span>
       <select class="select" id="fStatus">
         ${['进行中', '已完成', '已暂停'].map((s) => `<option${s === data.status ? ' selected' : ''}>${s}</option>`).join('')}
       </select></label>
     <div class="field"><span class="field__label">参与部门（可多选，一个项目可由多个部门共同完成）</span>${deptChecks}</div>`,
    `<button class="ghost" id="modalCancel" type="button">取消</button>
     <button class="primary" id="modalSave" type="button">${isNew ? '创建' : '保存'}</button>`,
  );
  $('modalCancel').onclick = closeModal;
  $('modalSave').onclick = async () => {
    const name = $('fName').value.trim();
    if (!name) return toast('请填项目名字');
    const departmentIds = [...el.modalBody.querySelectorAll('.fDept:checked')].map((node) => node.value);
    try {
      const result = await api('/api/project', {
        method: 'POST',
        body: JSON.stringify({ id: project?.id, name, description: $('fDesc').value.trim(), status: $('fStatus').value, departmentIds }),
      });
      closeModal();
      toast(isNew ? `已创建 ${name}` : '已保存');
      await loadState();
      if (isNew) switchContext('project', result.project.id);
    } catch (error) {
      toast(`保存失败：${error.message}`);
    }
  };
}

/** 全局设置 */
function openSettingsModal() {
  const keyPlaceholder = state.settings.hasKey ? '已设置（留空则保持不变）' : 'sk-…';
  openModal(
    '全局设置',
    `<p class="field__hint" style="margin-bottom:14px">这里填的通道是「默认通道」：没有单独设置 API 的员工都用它。</p>
     <label class="field"><span class="field__label">API Key</span>
       <input class="input" id="fKey" type="password" placeholder="${keyPlaceholder}" autocomplete="off" /></label>
     <label class="field"><span class="field__label">接口地址</span>
       <input class="input" id="fBase" value="${esc(state.settings.baseUrl || 'https://api.deepseek.com')}" spellcheck="false" /></label>
     <label class="field"><span class="field__label">默认模型</span>
       <input class="input" id="fModel" value="${esc(state.settings.model || 'deepseek-chat')}" /></label>
     <p class="field__hint">Key 只写进本机 <code>data/settings.json</code>，不上传。</p>`,
    `<button class="ghost" id="modalCancel" type="button">取消</button>
     <button class="primary" id="modalSave" type="button">保存</button>`,
  );
  $('modalCancel').onclick = closeModal;
  $('modalSave').onclick = async () => {
    const payload = { baseUrl: $('fBase').value.trim(), model: $('fModel').value.trim(), onboarded: true };
    const key = $('fKey').value.trim();
    if (key) payload.apiKey = key;
    try {
      await api('/api/settings', { method: 'POST', body: JSON.stringify(payload) });
      closeModal();
      toast('已保存');
      await loadState();
    } catch (error) {
      toast(`保存失败：${error.message}`);
    }
  };
}

/* ── 右键菜单 ─────────────────────────────────────────── */

function openContextMenu(x, y, items) {
  el.ctxmenu.innerHTML = items
    .map((item) => (item === '-'
      ? '<hr />'
      : `<button type="button" class="${item.danger ? 'is-danger' : ''}" data-action="${esc(item.action)}">${esc(item.label)}</button>`))
    .join('');
  el.ctxmenu.hidden = false;
  const rect = el.ctxmenu.getBoundingClientRect();
  el.ctxmenu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  el.ctxmenu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
  el.ctxmenu._items = items;
}

function closeContextMenu() {
  el.ctxmenu.hidden = true;
}

el.ctxmenu.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const item = (el.ctxmenu._items || []).find((entry) => entry.action === button.dataset.action);
  closeContextMenu();
  if (item?.run) await item.run();
});

el.ctxmenu.addEventListener('click', (event) => event.stopPropagation());

function employeeMenu(employee) {
  return [
    { action: 'panel', label: '打开工作面板', run: () => switchContext('employee', employee.id) },
    { action: 'config', label: '设置…', run: () => openEmployeeModal(employee) },
    '-',
    {
      action: 'delete',
      label: '删除员工',
      danger: true,
      run: async () => {
        if (!window.confirm(`确定删除「${employee.name}」？他的对话记录会保留。`)) return;
        await api('/api/employee/delete', { method: 'POST', body: JSON.stringify({ id: employee.id }) });
        toast('已删除');
        await loadState();
      },
    },
  ];
}

function departmentMenu(department) {
  return [
    { action: 'panel', label: '打开部门面板', run: () => switchContext('department', department.id) },
    { action: 'add', label: '添加员工…', run: () => openEmployeeModal(null, department.id) },
    { action: 'config', label: '设置…', run: () => openDepartmentModal(department) },
    '-',
    {
      action: 'delete',
      label: '删除部门',
      danger: true,
      run: async () => {
        if (!window.confirm(`确定删除部门「${department.name}」？部门里的员工不会被删除，只会变成未分配。`)) return;
        await api('/api/department/delete', { method: 'POST', body: JSON.stringify({ id: department.id }) });
        toast('已删除');
        await loadState();
      },
    },
  ];
}

function projectMenu(project) {
  return [
    { action: 'open', label: '打开项目面板', run: () => switchContext('project', project.id) },
    { action: 'config', label: '设置…', run: () => openProjectModal(project) },
    '-',
    {
      action: 'delete',
      label: '删除项目',
      danger: true,
      run: async () => {
        if (!window.confirm(`确定删除项目「${project.name}」？对话记录会保留。`)) return;
        await api('/api/project/delete', { method: 'POST', body: JSON.stringify({ id: project.id }) });
        toast('已删除');
        await loadState();
      },
    },
  ];
}

/* ── 开机引导 ─────────────────────────────────────────── */

function maybeShowOnboard() {
  if (state.settings.onboarded && state.departments.length) {
    el.onboard.hidden = true;
    return;
  }
  renderOnboard();
  el.onboard.hidden = false;
}

function renderOnboard() {
  const step = state.onboardingStep;
  const steps = ['① 填 API 通道', '② 建一个部门', '③ 加员工'];
  const stepBar = `<ul class="onboard__steps">${steps
    .map((label, index) => `<li class="${index === step ? 'is-on' : ''}">${label}</li>`).join('')}</ul>`;

  let body = '';
  if (step === 0) {
    body = `
      <label class="field"><span class="field__label">API Key</span>
        <input class="input" id="oKey" type="password" placeholder="sk-…" autocomplete="off" /></label>
      <label class="field"><span class="field__label">接口地址</span>
        <input class="input" id="oBase" value="${esc(state.settings.baseUrl || 'https://api.deepseek.com')}" spellcheck="false" /></label>
      <label class="field"><span class="field__label">默认模型</span>
        <input class="input" id="oModel" value="${esc(state.settings.model || 'deepseek-chat')}" /></label>
      <p class="field__hint">这是「默认通道」：没有单独配 API 的员工都用它。Key 只存本机。</p>`;
  } else if (step === 1) {
    body = `
      <label class="field"><span class="field__label">部门名字</span>
        <input class="input" id="oDeptName" placeholder="例如 研发部" /></label>
      <label class="field"><span class="field__label">部门职责（可留空）</span>
        <input class="input" id="oDeptDesc" placeholder="例如 负责产品实现与质量" /></label>`;
  } else {
    body = `
      <label class="field"><span class="field__label">名字</span>
        <input class="input" id="oEmpName" placeholder="例如 李四" /></label>
      <div class="row2">
        <label class="field"><span class="field__label">职能</span>
          <input class="input" id="oEmpTitle" placeholder="例如 后端工程师" /></label>
        <label class="field"><span class="field__label">层级</span>
          <select class="select" id="oEmpLevel">${levelOptions('worker')}</select></label>
      </div>
      <label class="field"><span class="field__label">所属部门</span>
        <select class="select" id="oEmpDept">${departmentOptions(state.departments[0]?.id)}</select></label>
      <label class="field"><span class="field__label">职责描述</span>
        <input class="input" id="oEmpDesc" placeholder="他负责什么" /></label>`;
  }

  const nextLabel = step === 2 ? '完成，开始使用' : '下一步';
  el.onboard.innerHTML = `
    <div class="onboard__card">
      <img class="onboard__logo" src="assets/message-board-icon.png" alt="" />
      <h2>${esc(APP_NAME)}</h2>
      <p>一个你，指挥一群绑定不同模型的 AI 员工。三步就能开工。</p>
      ${stepBar}
      ${body}
      <div class="modal__foot" style="border:0;padding:6px 0 0">
        <button class="ghost" id="oSkip" type="button">跳过引导</button>
        <button class="primary" id="oNext" type="button">${nextLabel}</button>
      </div>
    </div>`;

  $('oSkip').onclick = async () => {
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ onboarded: true }) });
    el.onboard.hidden = true;
    await loadState();
  };
  $('oNext').onclick = async () => {
    try {
      if (step === 0) {
        const payload = { onboarded: false, baseUrl: $('oBase').value.trim(), model: $('oModel').value.trim() };
        const key = $('oKey').value.trim();
        if (key) payload.apiKey = key;
        await api('/api/settings', { method: 'POST', body: JSON.stringify(payload) });
        state.onboardingStep = 1;
      } else if (step === 1) {
        const name = $('oDeptName').value.trim();
        if (!name) return toast('请填部门名字');
        await api('/api/department', { method: 'POST', body: JSON.stringify({ name, description: $('oDeptDesc').value.trim() }) });
        await loadState();
        state.onboardingStep = 2;
      } else {
        const name = $('oEmpName').value.trim();
        if (!name) return toast('请填员工名字');
        await api('/api/employee', {
          method: 'POST',
          body: JSON.stringify({
            name,
            title: $('oEmpTitle').value.trim() || '员工',
            level: $('oEmpLevel').value,
            departmentId: $('oEmpDept').value,
            description: $('oEmpDesc').value.trim(),
          }),
        });
        await api('/api/settings', { method: 'POST', body: JSON.stringify({ onboarded: true }) });
        el.onboard.hidden = true;
        await loadState();
        toast('已经可以开工了：在下面的输入框说点什么，或用 @名字 点名');
        return;
      }
      await loadState();
      renderOnboard();
    } catch (error) {
      toast(error.message);
    }
  };
}

/* ── 事件绑定 ─────────────────────────────────────────── */

el.projectList.addEventListener('click', (event) => {
  const row = event.target.closest('[data-kind]');
  if (!row) return;
  const project = projectById(row.dataset.id);
  if (project) switchContext('project', project.id);
});

el.teamTree.addEventListener('click', (event) => {
  const caret = event.target.closest('[data-toggle]');
  if (caret) {
    event.stopPropagation();
    const id = caret.dataset.toggle;
    if (state.expanded.has(id)) state.expanded.delete(id);
    else state.expanded.add(id);
    renderSidebar();
    return;
  }
  const row = event.target.closest('[data-kind]');
  if (!row) return;
  switchContext(row.dataset.kind, row.dataset.id);
});

el.panelRoster.addEventListener('click', (event) => {
  const item = event.target.closest('[data-kind="employee"]');
  if (item) switchContext('employee', item.dataset.id);
});

// 右键：员工 / 部门 / 项目
document.addEventListener('contextmenu', (event) => {
  const row = event.target.closest('[data-kind]');
  if (!row) return;
  const { kind, id } = row.dataset;
  const target = kind === 'employee' ? employeeById(id)
    : kind === 'department' ? departmentById(id)
      : kind === 'project' ? projectById(id) : null;
  if (!target) return;
  event.preventDefault();
  const items = kind === 'employee' ? employeeMenu(target)
    : kind === 'department' ? departmentMenu(target) : projectMenu(target);
  openContextMenu(event.clientX, event.clientY, items);
});

document.addEventListener('click', () => {
  if (!el.ctxmenu.hidden) closeContextMenu();
});

el.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  void send();
});

el.composerInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void send();
  }
});

el.composerInput.addEventListener('input', () => {
  const node = el.composerInput;
  node.style.height = 'auto';
  node.style.height = `${Math.min(node.scrollHeight, 180)}px`;
});

el.newDepartment.onclick = () => openDepartmentModal();
el.newProject.onclick = () => openProjectModal();
el.openSettings.onclick = () => openSettingsModal();
el.modalClose.onclick = closeModal;
el.modal.addEventListener('click', (event) => {
  if (event.target === el.modal) closeModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!el.modal.hidden) closeModal();
    if (!el.ctxmenu.hidden) closeContextMenu();
  }
});

// 深浅色
const savedTheme = localStorage.getItem('mb-theme');
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
el.themeToggle.onclick = () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('mb-theme', next);
};

/* ── 实时流 ───────────────────────────────────────────── */

function connectStream() {
  const source = new EventSource('/api/stream');
  source.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.mode === state.context.mode && message.threadId === state.context.id) {
      if (!state.messages.some((item) => item.id === message.id)) {
        state.messages.push(message);
        renderStream();
      }
    }
  });
  source.addEventListener('busy', (event) => {
    const { employeeId, busy } = JSON.parse(event.data);
    state.busy = busy
      ? [...new Set([...state.busy, employeeId])]
      : state.busy.filter((id) => id !== employeeId);
    renderSidebar();
  });
  source.addEventListener('org', () => { void loadState(); });
  source.addEventListener('error', (event) => {
    try {
      const data = JSON.parse(event.data);
      toast(`员工出错：${data.error}`);
    } catch { /* 忽略连接级错误 */ }
  });
  source.onerror = () => {
    // 断线由 EventSource 自动重连，这里不打扰用户
  };
}

/* ── 启动 ─────────────────────────────────────────────── */

loadState().catch((error) => {
  el.stream.innerHTML = `<div class="stream__empty">连不上服务端：${esc(error.message)}<br />请确认 <code>node server/index.js</code> 正在运行。</div>`;
});
connectStream();
