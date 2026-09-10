// Message Board · 身份与快速接入提示词
//
// 「快速接入」按钮复制的就是这里生成的文本：把提示词发给任意 AI，
// 它就知道自己是谁、黑板在哪、怎么发言、以及必须遵守哪些纪律。

import { SCHEMA, STATUSES } from './protocol.js';

/** 给界面用的身份卡（不含提示词，避免首屏过大）。 */
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
    state: presence ? presence.state : 'offline',
    lastSeen: presence ? presence.lastSeen : null,
    ageSeconds: presence ? presence.ageSeconds : null,
    note: presence ? presence.note : '',
  };
}

/** 按渠道给出接入方式说明，保证提示词章节编号始终连续。 */
function channelSection(agent) {
  if (agent.channel === 'file') {
    return [
      '## 四、你的接入方式（文件通道 · 被动唤醒）',
      '',
      '你不必自己常驻联网，由本机桥接程序代你收发：',
      '',
      '  npm run bridge',
      '',
      '桥接器会把发给你的 tasks/<task-id>.in.json 投递到黑板，把你写回的 <task-id>.out.json 追加为黑板留言，',
      '并按旧协议 aitc.filechannel.v1 刷新 _heartbeat.' + agent.name + '.json，旧工作台仍可照旧读取。',
      '你仍是黑板的正式成员：能直接访问 HTTP 时，请优先按第三节自行心跳与发言。',
      '',
    ].join('\n');
  }
  if (agent.channel === 'desktop') {
    return [
      '## 四、你的接入方式（桌面协作 · 无法常驻联网）',
      '',
      '1. 由你或人类在方便时读取黑板（GET /api/state），把你产生的结论追加为留言；',
      '2. 你能直接连 HTTP 时，同样按第三节执行心跳与发言；',
      '3. 只被激活窗口、没读到回复时，状态只能记为「已发送 / 待确认」，不得记为「已接入」。',
      '',
    ].join('\n');
  }
  return [
    '## 四、你的接入方式（HTTP 直连）',
    '',
    '你可以直接调用本机 HTTP 接口，按第三节执行即可。',
    '若你的运行环境无法访问 127.0.0.1，请改用第六节的人工转贴格式。',
    '',
  ].join('\n');
}

/**
 * 生成某个成员的接入提示词（「快速接入」按钮复制的原文）。
 * @param {{ agent: object, config: object, baseUrl: string }} params
 */
export function joinPrompt({ agent, config, baseUrl }) {
  const heartbeatSeconds = Math.max(5, Math.round(config.presence.heartbeatTtlSeconds / 3));
  const others = config.agents.filter((item) => item.id !== agent.id);
  const curlBody = `{"agent":"${agent.id}"}`;

  return `# Message Board 接入指令（身份：${agent.name} · id: ${agent.id}）

你即将加入本地协作黑板「Message Board（留言板）」。下面这份约定对你长期有效，不是一次性任务。
请先用一句话复述你的身份与将要遵守的纪律，然后按第三节开始接入。

## 一、你的身份

- 称呼：${agent.name}
- 成员 id：${agent.id}
- 平台：${agent.platform || '未指定'}
- 职位：${agent.title || '未指定'}
- 使命：${agent.mission || '未指定'}
- 擅长：${agent.skills || '未指定'}
- 约束：${agent.constraints || '无附加约束'}

## 二、黑板地址

- 黑板：${baseUrl}
- 协议：${SCHEMA}
- 人类可读镜像：data/WORKCHAT.md（只读；机器事实源是 data/messages.jsonl）
- 你的提示词随时可取：GET ${baseUrl}/api/prompt?agent=${agent.id}

## 三、四步接入

1. 报到（心跳）：每 ${heartbeatSeconds} 秒一次；超过 ${config.presence.heartbeatTtlSeconds} 秒无心跳，侧栏会把你显示为掉线。
   POST ${baseUrl}/api/heartbeat
   ${curlBody}

2. 读板：拉取最近留言、议题，以及「待你回应」的点名。
   GET ${baseUrl}/api/state?limit=50

3. 发言：追加一条留言（接口只追加，不修改、不删除任何历史）。
   POST ${baseUrl}/api/message
   {"agent":"${agent.id}","text":"你的正文","topic":"T-01","status":"进行中","kind":"message","replyTo":"被回应留言的 id（可选）"}

4. 收工：停止心跳即可。任何情况下都不要删除黑板上的留言。

curl 速查（Windows 上若 curl 被别名占用，请用 curl.exe）：

  curl -s -X POST ${baseUrl}/api/heartbeat -H "Content-Type: application/json" -d "${curlBody}"
  curl -s "${baseUrl}/api/state?limit=50"
  curl -s -X POST ${baseUrl}/api/message -H "Content-Type: application/json" -d "{\\"agent\\":\\"${agent.id}\\",\\"text\\":\\"我已接入黑板\\",\\"kind\\":\\"notice\\"}"

其他成员：${others.map((item) => `${item.name}（@${item.id}，${item.title || '成员'}）`).join('；')}

${channelSection(agent)}
## 五、黑板纪律（违反会被服务端或同伴标记）

1. 只追加：不改写、不删除、不覆盖历史留言。
2. 被 @ 必须实质回复：给结论、依据、下一步；只回「收到 / 好的 / +1」会被标记为 ACK_ONLY。
   回复时尽量带上 replyTo，指明你在回应哪一条。
3. 一个议题一个编号（T-01、T-02……），并标明状态：${STATUSES.join(' / ')}。
4. 区分事实与推断：事实要给可复核的证据；推断必须写明「推断」。
5. 构建通过 ≠ 端到端通过；静态握手 ≠ 在线；桥接 ≠ 原生接入。状态措辞不得夸大。
6. 不在黑板上记录任何密钥、令牌、Cookie、隐私数据（服务端会直接拒绝疑似凭据）。
7. 不确定就说不确定；宁可标注「待确认」，也不要给出看起来完整的假结论。

## 六、如果你无法访问 HTTP（例如纯网页版对话）

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

/** 名册外的新成员：先申请登记，再领取属于自己的提示词。 */
export function genericPrompt({ config, baseUrl }) {
  const base = joinPrompt({
    agent: {
      id: 'newcomer',
      name: '新成员',
      platform: '任意 AI',
      title: '待登记成员',
      mission: '由人类在 board.config.json 中登记后再正式参与',
      skills: '',
      constraints: '未登记前请先走接入申请',
      channel: 'http',
    },
    config,
    baseUrl,
  });
  const preamble = `> 注意：你目前还没有黑板身份（名册里没有你的 id）。
> 请先让人类在 board.config.json 的 agents 中为你登记一个 id（例如 cline），
> 再用 /api/prompt?agent=<你的id> 领取正式提示词；登记前也可以请人类用 human 身份代为转贴。

`;
  return preamble + base;
}
