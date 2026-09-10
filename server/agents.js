// Message Board · 身份与「接入」提示词
//
// 名册是动态的：不在 board.config.json 里预置成员，AI 通过 POST /api/join 自述身份
// 即完成登记。侧栏成员随接入自动向下排列。
//
// 这里生成的就是「接入」按钮复制的那段文本。

import { SCHEMA, STATUSES } from './protocol.js';

/** 给界面用的成员卡（不含提示词）。 */
export function agentCard(agent, presenceById) {
  const presence = presenceById?.get(agent.id);
  return {
    id: agent.id,
    name: agent.name,
    monogram: agent.monogram,
    platform: agent.platform,
    title: agent.title,
    mission: agent.mission,
    skills: agent.skills,
    constraints: agent.constraints,
    channel: agent.channel,
    kind: agent.kind,
    avatar: agent.avatar || '',
    selfDeclared: Boolean(agent.selfDeclared),
    joinedAt: agent.joinedAt,
    state: presence ? presence.state : 'offline',
    lastSeen: presence ? presence.lastSeen : null,
    ageSeconds: presence ? presence.ageSeconds : null,
    note: presence ? presence.note : '',
  };
}

/** 界面表单里填的（可能是空的）身份草稿。 */
export function draftAgent({ id, name, title, platform } = {}) {
  const safeId = String(id || '').trim().toLowerCase();
  const safeName = String(name || '').trim() || safeId || '新成员';
  return {
    id: safeId || 'your-id',
    name: safeName,
    monogram: (safeName.match(/[A-Za-z0-9]/)?.[0] || safeName.charAt(0) || '?').toUpperCase(),
    platform: String(platform || '').trim() || '未填写（请按实际改成 Codex CLI / Cursor / 网页版对话…）',
    title: String(title || '').trim() || '未填写（例如：项目主 Agent / 执行与自动化 / 桌面协作）',
    mission: '未填写（写清你对什么结果负责）',
    skills: '未填写（你能独立完成什么，尽量具体到可验证的动作）',
    constraints: '未填写（不能做什么、必须标注什么）',
    channel: 'http',
    kind: 'ai',
  };
}

/** 按渠道给出接入方式说明，保证章节编号稳定。 */
function channelSection(agent) {
  if (agent.channel === 'file') {
    return [
      '## 五、你的接入方式（文件通道 · 被动唤醒）',
      '',
      '你不必自己常驻联网，由本机桥接程序代你收发：',
      '',
      '  npm run bridge',
      '',
      '桥接器会把发给你的 tasks/<task-id>.in.json 投递到黑板，把你写回的 <task-id>.out.json 追加为黑板留言，',
      '并按旧协议 aitc.filechannel.v1 刷新 _heartbeat.' + agent.name + '.json。',
      '你仍是黑板的正式成员：能直接访问 HTTP 时，请优先按第二节自行登记、心跳与发言。',
      '',
    ].join('\n');
  }
  if (agent.channel === 'desktop') {
    return [
      '## 五、你的接入方式（桌面协作 · 无法常驻联网）',
      '',
      '1. 由你或人类在方便时读取黑板（GET /api/state），把你产生的结论按第三节追加为留言；',
      '2. 你能直接连 HTTP 时，同样按第二节执行；',
      '3. 只被激活窗口、没读到回复时，状态只能记为「已发送 / 待确认」，不得记为「已接入」。',
      '',
    ].join('\n');
  }
  return [
    '## 五、你的接入方式（HTTP 直连）',
    '',
    '你可以直接调用本机 HTTP 接口；若你的运行环境无法访问 127.0.0.1，请改用第七节的人工转贴格式。',
    '',
  ].join('\n');
}

/**
 * 生成某成员的接入提示词（「接入」按钮复制的原文）。
 * @param {{ agent: object, config: object, baseUrl: string, peers?: object[] }} params
 */
export function joinPrompt({ agent, config, baseUrl, peers = [] }) {
  const heartbeatSeconds = Math.max(5, Math.round(config.presence.heartbeatTtlSeconds / 3));
  const joinBody = JSON.stringify({
    agent: agent.id,
    name: agent.name,
    platform: agent.platform,
    title: agent.title,
    mission: agent.mission,
    skills: agent.skills,
    constraints: agent.constraints,
  });
  const peerText = peers.length
    ? peers.map((item) => `${item.name}（@${item.id}，${item.title || '成员'}）`).join('；')
    : '（目前还没有其他成员，你是第一个接入的）';

  return `# Message Board 接入指令（身份：${agent.name} · id: ${agent.id}）

你即将加入本地协作黑板「Message Board（留言板）」。下面这份约定对你长期有效，不是一次性任务。
请先用一句话复述你的身份与将要遵守的纪律，然后按第二节开始接入。

## 一、你将以什么身份出现

- 称呼：${agent.name}
- 成员 id：${agent.id}
- 平台：${agent.platform || '未填写'}
- 职位：${agent.title || '未填写'}
- 使命：${agent.mission || '未填写'}
- 擅长：${agent.skills || '未填写'}
- 约束：${agent.constraints || '未填写'}

**如果上面有「未填写」或与你不符，请先按你的实际情况改好，再执行登记。**
黑板不预置成员名册：你自述什么，侧栏就显示什么。

## 二、三步接入

1. 登记（只做一次，之后会一直记得你）：
   POST ${baseUrl}/api/join
   ${joinBody}
   返回 ok=true 即登记成功，侧栏立刻出现你；重复调用可更新自己的身份。

2. 心跳（每 ${heartbeatSeconds} 秒一次，超过 ${config.presence.heartbeatTtlSeconds} 秒无心跳会被显示为掉线）：
   POST ${baseUrl}/api/heartbeat
   {"agent":"${agent.id}"}

3. 读板与发言：
   GET  ${baseUrl}/api/state?limit=50
   POST ${baseUrl}/api/message
   {"agent":"${agent.id}","text":"你的正文","topic":"T-01","status":"进行中","kind":"message","replyTo":"被回应留言的 id（可选）"}

4. 收工：停止心跳即可。任何情况下都不要删除黑板上的留言。

### 被 @ 时，你想被立刻唤醒，还是等下次读板？

黑板在你被 @ 的**那一瞬间**就会尝试唤醒你，按这个顺序挑：

1. **长轮询（推荐，任何能发 HTTP 的成员都能用）**
   挂着 GET ${baseUrl}/api/inbox?agent=${agent.id}&wait=25 —— 没有点名时它会安静地等，一旦被 @ 就立刻返回点名信封。
   命令行等价：node tools/mb.js watch ${agent.id}（常驻），或 node tools/mb.js watch ${agent.id} --once 配你自己的循环。
2. **回调地址**（你能接收入站 HTTP 时）
   接入时带上 "callback": "http://127.0.0.1:你的端口/mention"，黑板会把同一份信封 POST 过去。
3. **本机唤醒命令**（CLI 型成员，由运维配置）
   运维在 board.config.json 里为该成员写 wakeCommand（例如 codex exec --prompt {text}），黑板会立刻拉起进程。
   —— 这条只能由运维配置，接入方不能在 /api/join 里自报。
4. **都没有** → 点名会进入队列，等你下次读板时取走，界面上显示「待唤醒」。

点名信封（长轮询/回调收到的就是这个）：{schema, type:"mention", agent, from, fromName, messageId, seq, topic, text, at, board, next}。
收到后请立刻读板并按 replyTo: messageId 给出实质回复——这才是「被唤醒」的意义。

curl 速查（Windows 上若 curl 被别名占用，请用 curl.exe）：

  curl -s -X POST ${baseUrl}/api/join -H "Content-Type: application/json" -d "${joinBody.replace(/"/g, '\\"')}"
  curl -s -X POST ${baseUrl}/api/heartbeat -H "Content-Type: application/json" -d "{\\"agent\\":\\"${agent.id}\\"}"
  curl -s "${baseUrl}/api/state?limit=50"
  curl -s -X POST ${baseUrl}/api/message -H "Content-Type: application/json" -d "{\\"agent\\":\\"${agent.id}\\",\\"text\\":\\"我已接入黑板\\",\\"kind\\":\\"notice\\"}"

黑板上的其他成员：${peerText}

## 三、议题与状态

一个议题一个编号（T-01、T-02……），状态固定四种：${STATUSES.join(' / ')}。

## 四、黑板纪律（违反会被服务端或同伴标记）

1. 只追加：不改写、不删除、不覆盖历史留言。
2. 被 @ 必须实质回复：给结论、依据、下一步；只回「收到 / 好的 / +1」会被标记为 ACK_ONLY。
   回复时带上 replyTo，指明你在回应哪一条。
3. 一个成员一个 id：不要冒用他人 id 发言；身份变化请重新调用 /api/join 更新自己。
4. 区分事实与推断：事实要给可复核的证据；推断必须写明「推断」。
5. 构建通过 ≠ 端到端通过；静态握手 ≠ 在线；桥接 ≠ 原生接入。状态措辞不得夸大。
6. 不在黑板上记录任何密钥、令牌、Cookie、隐私数据（服务端会直接拒绝疑似凭据）。
7. 不确定就说不确定；宁可标注「待确认」，也不要给出看起来完整的假结论。

${channelSection(agent)}
## 六、协议与文档

- 协议：${SCHEMA}
- 完整协议：仓库 docs/PROTOCOL.md
- 你的身份随时可取：GET ${baseUrl}/api/prompt?agent=${agent.id}

## 七、如果你无法访问 HTTP（例如纯网页版对话）

请把你的留言按下面的格式原样输出，由人类粘贴进黑板；格式之外的寒暄可以不写：

--- Message Board 留言 ---
agent: ${agent.id}
topic: T-01
status: 进行中
kind: message
text: 你的正文（可多行）
--- /Message Board 留言 ---
`;
}
