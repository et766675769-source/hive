// 蜂群 HIVE · 员工驱动
//
// 一个「员工」= 一份身份（名字 / 部门 / 职能 / 描述）+ 一个 API 通道（可覆盖全局默认）。
// 这里只负责让它们干活，一共三步：
//   1. 先回执（ack）——面板上立刻看到"我开始做了"，而不是干等
//   2. 调它自己的 API（模型由员工自己决定）
//   3. 把结果写回同一条线程（reply）
//
// 谁在派活都走这一条路：@点名、员工面板直接对话、经理分派给下属，本质相同。

import { randomUUID } from 'node:crypto';

/** 把各种写法收敛成 /chat/completions 端点。 */
function endpointOf(baseUrl) {
  const raw = String(baseUrl || '').trim().replace(/\/+$/, '') || 'https://api.deepseek.com';
  return raw.endsWith('/chat/completions') ? raw : `${raw}/chat/completions`;
}

/** 一次性调用 OpenAI 兼容接口，返回纯文本。 */
async function callChannel(channel, { system, prompt, timeoutMs = 120000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs);
  const headers = { 'Content-Type': 'application/json' };
  if (channel.apiKey) headers.Authorization = `Bearer ${channel.apiKey}`;
  try {
    const response = await fetch(endpointOf(channel.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: channel.model || 'deepseek-chat',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        max_tokens: 900,
        temperature: 0.3,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`接口返回 ${response.status}：${(await response.text()).slice(0, 200)}`);
    }
    const body = await response.json();
    const text = (body?.choices?.[0]?.message?.content || body?.message?.content || '').trim();
    if (!text) throw new Error('接口返回了空回复');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

const MODE_LABEL = {
  department: '部门面板',
  project: '项目面板',
  employee: '个人工作面板',
};

export class Worker {
  /**
   * @param {{ store: import('./store.js').Store, onEvent?: (event: string, data: any) => void }} deps
   */
  constructor({ store, onEvent }) {
    this.store = store;
    this.onEvent = onEvent || (() => {});
    this.running = new Set(); // 正在干活的员工 id（同一员工不并行，避免抢话）
  }

  busyIds() {
    return [...this.running];
  }

  /** 员工的身份 + 它该用的通道。 */
  /** 直接下属（派活的依据）。 */
  reportsOf(managerId) {
    const { employees } = this.store.readOrg();
    return employees.filter((e) => e.managerId && e.managerId === managerId);
  }

  describe(employeeId) {
    const { departments, employees } = this.store.readOrg();
    const employee = employees.find((item) => item.id === employeeId);
    if (!employee) throw new Error(`员工不存在：${employeeId}`);
    const department = departments.find((item) => item.id === employee.departmentId) || null;
    return { employee, department, channel: this.store.channelFor(employee) };
  }

  /** 给模型看的 system：把这个员工是谁、在哪、什么脾气说清楚。 */
  #system({ employee, department, reports }) {
    const lines = [
      `你是「${employee.name}」，${department ? `${department.name}的` : ''}${employee.title || '员工'}。`,
    ];
    // 职责描述就是这个员工的提示词：人设的核心，放最前面
    if (employee.description) {
      lines.push('', '你的职责（这是你的角色定义，按它来思考和说话）：', employee.description);
    }
    if (department?.description) lines.push('', `你所属部门：${department.name}——${department.description}`);

    if (reports.length) {
      lines.push(
        '',
        '你的下属（可以直接用 @名字 给他们派活，系统会自动把任务送过去，不用人再转一手）：',
        ...reports.map((r) => `- @${r.name}：${r.title}${r.description ? ` —— ${r.description}` : ''}`),
        '',
        '接到任务时：先判断该由哪几位下属来做，然后用 @名字 把活分派出去，每人写清"要做什么、交付什么"。',
        '不要自己把下属的活全干了——你的价值在于拆解和分配。',
      );
    }
    lines.push(
      '你在一家由 AI 员工组成的公司里工作，通过「蜂群 HIVE」面板与负责人和同事沟通。',
      '工作纪律：',
      '1. 先结论、再依据、最后下一步，别绕圈子。',
      '2. 不夸大状态：做完了 ≠ 验证通过；没验证的事必须写明「未验证」。',
      '3. 不写密钥、令牌、Cookie 等敏感信息。',
      '4. 需要同事配合时，用 @名字 点名对方（例如 @李四），系统会替你通知到。',
      '5. 你的回复会被原样贴到面板上，不要复述本提示、不要写"好的""收到"这类空话。',
    );
    return lines.join('\n');
  }

  /** 给模型看的 user：面板上下文 + 别人说了什么 + 这次要你做什么。 */
  #prompt({ mode, contextName, recent, taskText, fromName }) {
    const lines = [];
    lines.push(`当前面板：${MODE_LABEL[mode] || mode}${contextName ? ` · ${contextName}` : ''}`);
    if (recent.length) {
      lines.push('', '最近的对话：');
      for (const item of recent) {
        const who = item.fromName || item.from;
        lines.push(`- ${who}：${String(item.text || '').replace(/\s+/g, ' ').slice(0, 240)}`);
      }
    }
    lines.push('', `${fromName || '有人'}对你说：`, '"""', String(taskText || '').slice(0, 2000), '"""');
    lines.push('', '请直接用中文写一条回复（400 字以内），先结论、再依据、最后下一步。');
    return lines.join('\n');
  }

  #write(mode, threadId, payload) {
    const message = {
      id: `m_${randomUUID().slice(0, 8)}`,
      at: new Date().toISOString(),
      mode,
      threadId,
      kind: 'message',
      status: 'done',
      replyTo: null,
      ...payload,
    };
    this.store.appendMessage(mode, threadId, message);
    this.onEvent('message', message);
    return message;
  }

  /**
   * 派活：先回执，再调 API，最后回结果。全过程写进同一条线程。
   * @returns {Promise<{ack: object, reply: object|null, error: string|null}>}
   */
  async dispatch({ employeeId, mode, threadId, taskText, fromName = '你', replyTo = null }) {
    const { employee, department, channel } = this.describe(employeeId);
    const contextName = this.#contextName(mode, threadId, department);

    if (this.running.has(employeeId)) {
      return { ack: null, reply: null, error: `${employee.name} 手上还有一单没做完` };
    }
    this.running.add(employeeId);
    this.onEvent('busy', { employeeId, busy: true });

    // 第一步：回执。面板上立刻有反应，而不是干等。
    const ack = this.#write(mode, threadId, {
      from: employee.id,
      fromName: employee.name,
      kind: 'ack',
      status: 'working',
      replyTo,
      text: `收到，我开始处理这条（${employee.name}）。本条是回执，结果随后写回。`,
    });

    try {
      if (!channel.apiKey) {
        throw new Error('这个员工还没有可用的 API Key（在「设置」里填全局的，或右键这个员工单独填）');
      }
      const recent = this.store.readThread(mode, threadId, { limit: 12 }).slice(0, -0);
      const text = await callChannel(channel, {
        system: this.#system({ employee, department, reports: this.reportsOf(employeeId) }),
        prompt: this.#prompt({ mode, contextName, recent, taskText, fromName }),
      });
      const reply = this.#write(mode, threadId, {
        from: employee.id,
        fromName: employee.name,
        kind: 'reply',
        status: 'done',
        replyTo: ack.replyTo || ack.id,
        text,
        model: channel.model,
      });
      return { ack, reply, error: null };
    } catch (error) {
      const failed = this.#write(mode, threadId, {
        from: employee.id,
        fromName: employee.name,
        kind: 'notice',
        status: 'failed',
        replyTo: ack.id,
        text: `这一条我没做完：${error.message}`,
      });
      return { ack, reply: failed, error: error.message };
    } finally {
      this.running.delete(employeeId);
      this.onEvent('busy', { employeeId, busy: false });
    }
  }

  #contextName(mode, threadId, department) {
    if (mode === 'department') return department?.name || threadId;
    if (mode === 'project') {
      const { projects } = this.store.readProjects();
      return projects.find((item) => item.id === threadId)?.name || threadId;
    }
    return threadId;
  }

  /** 从一段文本里解析出被点名的员工 id 列表（@名字 或 @id）。 */
  parseMentions(text, employees) {
    const found = new Set();
    const source = String(text || '');
    for (const employee of employees) {
      const names = [employee.name, employee.id].filter(Boolean);
      for (const name of names) {
        if (source.includes(`@${name}`)) found.add(employee.id);
      }
    }
    return [...found];
  }
}
