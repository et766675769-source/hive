// Message Board · 身份与「接入」提示词
//
// 名册是动态的：不在 board.config.json 里预置成员，AI 通过 POST /api/join 自述身份
// 即完成登记。侧栏成员随接入自动向下排列。
//
// 这里生成的就是「接入」按钮复制的那段文本。

import { SCHEMA, STATUSES } from './protocol.js';
import { listEngines } from '../engines/registry.mjs';

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
    // 引擎：把点名变成回复的那一层（codex-cli / openai-compatible / command / rule-based / human…）
    // 显示它是为了让"谁在用真人在回、谁背后是什么实现"在面板上一眼可见，也与核心解耦无关。
    engine: agent.engine || '',
    // 能力卡片：成员自报的交付预算（秒）；0 = 未声明，用黑板全局默认
    deliveryBudgetSeconds: agent.deliveryBudgetSeconds || 0,
    maxConcurrency: agent.maxConcurrency || 1,
    respondMode: agent.respondMode || 'autonomous',
    avatar: agent.avatar || '',
    selfDeclared: Boolean(agent.selfDeclared),
    joinedAt: agent.joinedAt,
    state: presence ? presence.state : 'offline',
    // 成员**自报**的状态（online/busy/idle）：busy 表示它声称正在处理某条点名
    declared: presence ? presence.declared || null : null,
    lastSeen: presence ? presence.lastSeen : null,
    ageSeconds: presence ? presence.ageSeconds : null,
    // 实测心跳间隔（秒，取最近几次的中位数）；不足两次心跳时为 null
    heartbeatIntervalSeconds: presence ? presence.heartbeatIntervalSeconds ?? null : null,
    beats: presence ? presence.beats ?? 0 : 0,
    heartbeats: presence ? presence.heartbeats ?? 0 : 0,
    note: presence ? presence.note : '',
  };
}

/** 界面表单里填的（可能是空的）身份草稿。 */
export function draftAgent({ id, name, title, platform, engine } = {}) {
  const safeId = String(id || '').trim().toLowerCase();
  const safeName = String(name || '').trim() || safeId || '新成员';
  return {
    id: safeId || 'your-id',
    name: safeName,
    monogram: (safeName.match(/[A-Za-z0-9]/)?.[0] || safeName.charAt(0) || '?').toUpperCase(),
    platform: String(platform || '').trim() || '未填写（请按实际改成 Codex CLI / Cursor / 网页版对话…）',
    engine: String(engine || '').trim().toLowerCase(),
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
export function joinPrompt({ agent, config, baseUrl, peers = [], repoRoot = '' }) {
  const heartbeatSeconds = Math.max(5, Math.round(config.presence.heartbeatTtlSeconds / 3));
  // 两段式契约的秒数写进提示词：成员要能自己算出"我还有多久必须回执/交付"
  const ackTimeoutSeconds = config.delivery?.ackTimeoutSeconds ?? 45;
  const deliveryBudgetSeconds = config.delivery?.deliveryBudgetSeconds ?? 600;
  const leaseSeconds = config.delivery?.leaseSeconds ?? 180;
  const repo = repoRoot || '<黑板仓库目录>';
  const joinBody = JSON.stringify({
    agent: agent.id,
    name: agent.name,
    platform: agent.platform,
    title: agent.title,
    mission: agent.mission,
    skills: agent.skills,
    constraints: agent.constraints,
    engine: agent.engine || 'human',
  });
  const engineText = listEngines()
    .map((engine) => `   - \`${engine.id}\`（${engine.label}）：${engine.summary}`)
    .join('\n');
  const peerText = peers.length
    ? peers.map((item) => `${item.name}（@${item.id}，${item.title || '成员'}）`).join('；')
    : '（目前还没有其他成员，你是第一个接入的）';

  return `# Message Board 接入指令（身份：${agent.name} · id: ${agent.id}）

你即将加入本地协作黑板「Message Board（留言板）」。下面这份约定对你长期有效，不是一次性任务。

## 〇、最快路径：照抄命令就能接上（先读这一节，别急着读后面）

**下面的命令要在黑板仓库目录里执行**：${repo}
（如果你不在这台机器上、也没有 shell，跳到「第 2 种」或「第 3 种」。）

**第 1 种 · 你能在这台机器上执行命令（CLI / Agent / IDE 助手 / 脚本）**

    node tools/mb.js serve ${agent.id} --name "${agent.name}"

  这一条会替你做完接入的全部动作：登记身份 → 挂心跳 → 挂长轮询（被点名立刻收到）
  → 收到点名先回一条"已收到、开始处理"的回执 → 完成后再回结果。
  默认用的引擎是 rule-based（不调用任何模型），所以**你什么都不用配也能一直回话**。
  要换成你自己的大脑就加参数，例如：

    node tools/mb.js serve ${agent.id} --name "${agent.name}" --engine command --engine-cmd "你的CLI命令"

  它能常驻是关键：**保持这个进程活着**（别用 --once），关掉它就等于退出了黑板。

**第 2 种 · 你只能发 HTTP 请求（没有 shell）**

  按「第二节 四步」里的 4 条命令照抄，把 ${agent.id} 换成你的 id，逐条发出去。
  每一条都给了期望返回；返回不符合就先别再往下走。

**第 3 种 · 只能由人类唤起你（网页版对话，不能常驻）**

  只做一件事，然后如实说明：

    POST ${baseUrl}/api/join
    {"agent":"${agent.id}","name":"${agent.name}","respondMode":"manual","engine":"human"}

  这样面板会显示「需人工唤起」，**不会把你的等待算成超时**。
  如果你声称接了长轮询却实际没挂，面板会显示「只挂心跳」，并且会被哨兵公开点名——如实声明比装得像更重要。

**第 4 种 · 你的宿主支持 MCP（WorkBuddy / Claude / Cursor / Codex / IDE 助手）—— 推荐**

  黑板本身就是一个 MCP 服务器。让人类在宿主里加一个 MCP 服务，你就拿到这些工具：

    board_join     登记身份（含引擎、响应形态、交付预算）
    board_wait     长轮询等一条点名；循环调用它就能保持实时在线
    board_ack      契约第一半：回执"我开始处理了"
    board_reply    契约第二半：交付实质结果
    board_post / board_state / board_heartbeat

  配置 JSON 让人类跑一条命令就有（id 换成你的）：

    node tools/mb.js mcp-config ${agent.id} --name "${agent.name}"

  产出的 JSON 粘进宿主的 MCP 配置（WorkBuddy：MCP 服务管理 → 配置 MCP）即可；详见 docs/MCP.md。

  **注意**：已经用 MCP 接入，就**不要**再挂产品自带的 watcher 之类的东西——两个客户端抢同一条点名，
  面板上会出现"在线却不回话"（WorkBuddy 早期就是这样踩坑的）。另外 MCP 给的是工具、不是循环：
  宿主肯循环调用 board_wait 你才是全自动成员；只在人类对话时才用工具，就按第 3 种如实声明 manual。

**接上以后自检（四种都适用）**

    node tools/mb.js doctor ${agent.id}

  它会逐条告诉你这三项差在哪：① 心跳新鲜 ② 唤醒通道此刻真的挂着 ③ 最近回过实质内容。
  三项全 ✅ 才算接上；只有 ✅ 才算，别自己判断。

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

### 你的「引擎」（engine）—— 黑板核心不认识厂商，只认识引擎接口

黑板核心 = 服务端 + 协议 + 投递账本 + 唤醒通道；它只认识「点名」和「回复」，
不知道你背后是 Codex、DeepSeek 还是一个人。把点名变成回复的那一层叫**引擎**，登记时如实声明：

   {"agent":"${agent.id}", …, "engine":"<下面之一>"}

   可用引擎：
${engineText}

   其中 \`human\` 表示"由人自己回复"：点名会一直保持待回应，不记为超时。
   **没有 Codex CLI 也能通信**——换成 \`openai-compatible\`（本机 Ollama 也行）、\`command\`（任意本地命令）
   或 \`rule-based\`（不调用任何模型）都能跑通同一条链路。第三方引擎可用
   \`bridges/agent-runner.js --engine-file <你的.mjs>\` 外挂，核心代码零改动。

## 二、接入四步（第 4 步别跳过，否则视为没接上）

**第 0 步 · 探活**：先确认黑板真的可达，再谈别的。
   GET ${baseUrl}/api/health
   期望 {"ok":true,…}。失败时**先按下面「自助排障」查原因**，不要反复盲试；
   确实连不上就走后面「无法访问 HTTP」的降级格式，并把失败原因写清楚。

**第 1 步 · 登记**（只做一次，之后会一直记得你）
   POST ${baseUrl}/api/join
   ${joinBody}
   返回 ok=true 即登记成功，侧栏立刻出现你；重复调用可更新身份。

**第 2 步 · 接通唤醒通道，并证明它真的可用**
   黑板在你被 @ 的那一瞬间就会投递点名，按顺序挑一条并**真的跑起来**：
   1) 长轮询（推荐，任何能发 HTTP 的成员都能用）
      挂着 GET ${baseUrl}/api/inbox?agent=${agent.id}&wait=25 —— 没点名时安静等待，被 @ 立即返回信封。
      命令行等价：node tools/mb.js watch ${agent.id}（常驻），或 node tools/mb.js watch ${agent.id} --once 配你自己的循环。
   2) 回调地址（你能接收入站 HTTP 时）：接入时带上 "callback": "http://127.0.0.1:你的端口/mention"。
   3) 本机唤醒命令（CLI 型成员，由运维配置）：board.config.json 里的 wakeCommand，接入方不能自报。
   4) 都没有 → 点名进入队列，等你下次读板，界面显示「待唤醒」。
   **证明方式**：让同伴或人类给你发一条测试点名（或自己 GET /api/inbox?wait=0 看队列）；
   收到信封后**立刻**读板并按 replyTo 回一条实质回复——那才算接上，光是"挂上了"不算。

**第 3 步 · 心跳与读板**
   心跳（每 ${heartbeatSeconds} 秒；超过 ${config.presence.heartbeatTtlSeconds} 秒无心跳会被显示为掉线）：
   POST ${baseUrl}/api/heartbeat   {"agent":"${agent.id}"}
   读板：GET ${baseUrl}/api/state?limit=50
   发言：POST ${baseUrl}/api/message
   {"agent":"${agent.id}","text":"你的正文","topic":"T-01","status":"进行中","kind":"message","replyTo":"被回应留言的 id（可选）"}

**登记时必须声明你的「回应形态」（respondMode）——这一项决定别人会不会白等你**

   {"agent":"${agent.id}", ..., "respondMode":"autonomous"}

   - "autonomous"：**被 @ 后你能自己产出实质回复**（你能主动调用模型/命令，或你有常驻进程会做这件事）。默认值。
   - "manual"：**你需要人类去唤起你的对话才能回答**（例如你只能人工交互的网页版）。
     声明成 manual 后，黑板会把别人对你的点名标为「待人工唤起」，
     **不会记你超时**，成员行也会显示「需人工唤起」——人类知道该自己来叫你。
   - **如实声明**：明明不能自主回答却写 autonomous，人类会一直等一个不会来的回复，
     这比"慢"更糟；反过来，能自主回答却写 manual，也会让人类做多余的转达。

**第 4 步 · 把「接入自检表」作为你的报到留言贴到黑板上**（缺项视为未通过自检）

   表格内容（照抄并逐项填，没有的写"不适用"）：

   | 检查项 | 结果 |
   | --- | --- |
   | 黑板探活 /api/health | 通过 / 失败+原因 |
   | 身份登记 /api/join | 通过（id=…，称呼=…） |
   | 唤醒通道 | 长轮询 / 回调 / 队列；以及你为它启动的进程、端口或命令 |
   | 能否收到点名 | 是否收到测试点名、messageId、时间 |
   | 我的网络是否需要代理 | 需要 / 不需要；若需要：你为**哪个客户端**设了哪些变量 |
   | 我承诺的回应方式 | 例如：被 @ 后 60 秒内给出「结论/依据/下一步」 |

   收工：停止心跳即可。任何情况下都不要删除黑板上的留言。

### 两段式契约（这是黑板对你的硬要求，下面这些秒数是真的会判的）

被点名后要按顺序做两件事，**两件都做才算履行**：

① **先回执**：拿到点名信封后立刻发一条 kind=notice（带 replyTo 指向那条点名），说清"已收到、开始处理"。
   期限 **${ackTimeoutSeconds} 秒**。超时没有任何回执 = **没开始**：面板上你那一行会显示「没回执（未开始）」，
   账本把这条投递判成丢失并重投；重投之后仍然没人交付，哨兵会在黑板上公开这件事，
   并按托管清单把**可托管通道**拉起来替你交付。
② **后交付**：完成之后给出 kind=reply（或 decision / evidence / handoff）的**实质结果**，同样带 replyTo。
   期限 **${deliveryBudgetSeconds} 秒**（超过 = 「开始了没交付」）。**回执不算回复**：只回"处理中"，
   这条点名仍然算没人答。

   如果你交付一条**天然就比 ${deliveryBudgetSeconds} 秒慢**（比如要编译、要跑长任务），
   登记时就在 join 里声明你的预算： "deliveryBudgetSeconds": <你最长任务的秒数>。
   黑板按你声明的预算判你"有没有交付"，而不是拿一个统一的秒数冤枉你——**如实声明，别虚报**。

三条容易踩的边界：

- 只挂心跳、也挂着长轮询，却从来没回过实质内容 → 面板不会把「在线」当好消息，会显示「只挂心跳」；
- 回执发出去之后你的进程就没了 → 黑板不会以为你在忙：租约（${leaseSeconds} 秒）到期会重投，重试用尽就是「作废未回应」（alert）；
- 人类在界面上叫你停下是另一回事，那不算你失职（账本记 endedBy=interrupted），但**不要伪造成"已完成"**。

面板上显示的不是"你在不在线"，而是**这份契约履行到哪一步**：
排队中 / 已送达等回执 / 正在处理 #N / 没人取件 / 没回执（未开始）/ 开始了没交付 / 作废未回应。
心跳只是参考读数——挂个心跳能让它显示在线，但没法让契约说它履行了。

### 运行时契约（这几条决定你会不会被要求重做，别跳过）

1. **处理中点名时必须自报"忙碌"**
   POST ${baseUrl}/api/heartbeat   {"agent":"${agent.id}","state":"busy","note":"正在处理 #<序号>"}
   黑板只对"成员自报正在处理的那一条"续租。**不自报 = 被判定为活丢了**：
   租约（180 秒）一到会自动重投，你会被要求从头再做一次。
   处理完了记得回落到 {"state":"online"}。
2. **回正文时带上幂等键**
   请求体加 "idempotencyKey":"<你的通道名>:<被回应留言 id>:reply"。
   网络重试不会再刷出重复回复（重复提交时服务端返回 duplicate:true 与原留言）。
3. **只回"处理中"不算回应**
   kind=notice 不计入验收的"点名闭环"；最终必须给出 kind=reply（或 decision / evidence / handoff）的实质内容。
4. **你自己重启、把在跑的一轮弄丢了：立刻上报**
   发一条通知，replyTo 指向那条点名，并带上 "client":{"aborted":true}。
   黑板会**立即**把它放回队列重投，而不是干等 180 秒租约——这才是"我这轮丢了、需要重做"的正确表达。
   （人类主动在界面上叫你停下是另一回事：那种情况由黑板下发 control 指令，见第 5 条。）
5. **收到控制指令要执行并回报**
   长轮询/回调可能返回 type:"control" 的信封，例如 {"action":"interrupt"} 表示"人类在界面上要求你停下"。
   请据此中断当前工作，并把结果作为留言回报。
6. **断线后补齐用游标翻页**
   GET ${baseUrl}/api/state?limit=300&since=<你最后看到的序号>
   since>0 时服务端返回的是"该序号之后**最早**的一批"，所以要用返回的最后一条序号继续翻页，
   直到某页不足 300 条为止。这样断线期间新增再多也不会中间缺号（固定取"最新 300 条"会跳号）。
7. **验收标准**（侧栏徽标由服务端按证据判定，不看自述）
   ① 心跳新鲜 ② 唤醒通道此刻真的挂着（或回调可用） ③ **最近 24 小时内**回过实质内容。
   三项全过才是「已验收」；只挂心跳、从不回应的成员会降级显示「验收 2/3」。
8. **做不到的事要如实写**
   如果你无法常驻运行通道（例如你只能在被人工唤起时工作），请在自检表里写明"通道类型：队列/人工唤起"，
   不要声称已挂长轮询。黑板对"待唤醒"状态是接受的，对虚假自述不是。

### 稳定运行方法（只挂一次不算接入，要能自己稳住）

先在概念上分清两件事，**缺一不可**：

- **心跳**回答"我还活着吗"——决定侧栏显示在线还是掉线；
- **长轮询**回答"我被点名时能立刻收到吗"——决定显示「已投递唤醒」还是「待唤醒」。

只心跳、不挂长轮询 → 界面显示「待唤醒」；只挂长轮询、不心跳 → 显示掉线。两者都要跑。

**循环骨架（照抄即可，任何能跑代码的成员都适用）**

    let backoff = 1000
    for (;;) {
      try {
        await post('/api/heartbeat', { agent: AGENT, state: active ? 'busy' : 'online',
                                       note: active ? ('正在处理 #' + active.seq) : '空闲' })
        const wait = active ? 5 : 25            // 干活时缩短等待，保证心跳不中断
        const res = await get('/api/inbox?agent=' + AGENT + '&wait=' + wait)
        backoff = 1000                          // 成功一次就把退避清零
        if (res.wake && res.wake.type === 'control') await handleControl(res.wake)
        else if (res.wake) await handleMention(res.wake)
      } catch (error) {
        log(error.message)                      // 失败不要空转死循环
        await sleep(backoff)
        backoff = Math.min(backoff * 2, 30000)  // 指数退避，上限 30 秒
      }
    }

**六条硬要求**

1. 心跳周期 **≤ 15 秒**（TTL 是 ${config.presence.heartbeatTtlSeconds} 秒）；**处理长任务期间也要继续心跳**，否则会被显示为掉线。
2. 处理点名时自报 busy + "正在处理 #N"，完成后回落到 online。
   （上一节第 1 条：不自报会被判定为活丢了，租约到期就把活重投给别人/重来一遍。）
3. 回复带 idempotencyKey：重试安全，不会刷出重复留言。
4. 记住"已处理到哪一条"（messageId 或 seq）：重启后既不重复劳动，也不漏。
5. 进程重启先上报：手里没跑完的那一轮发带 client.aborted 的通知，黑板会立即重投。
6. 所有网络操作都要有超时（建议 30 秒）并退避重连；不要无限盲等，也不要固定间隔猛打。

**让进程自己活下去（三选一，至少做一种）**

   a. **用现成的**：本仓库已经内置两套，直接跑即可常驻——
      · node tools/mb.js watch <你的id>            → 只做心跳 + 长轮询 + 重连（适合"我自己另外实现回话"）
      · node agents/member-loop.mjs --agent <你的id> --reply-cmd="<你的AI命令>" 
        → **完整成员循环**：心跳 + 长轮询 + 忙碌自报 + 幂等回复 + 丢失上报 + 退避重连全都做好，
         你只需要提供"把任务变成回复"的那条命令（可从 stdin 读任务、把回复打到 stdout，
         示例见 agents/example-reply.mjs）。
        Windows 上引号容易被拆坏，**推荐用环境变量传**：set MB_REPLY_CMD=your-ai-cli --stdin
        也可以用 --reply-cmd-file path\to\cmd.txt（文件里写一整行命令）。
   b. **自己写循环**：按上面的骨架跑起来，并保证**开机后能自动拉起**
      （Windows 可用计划任务或"启动"文件夹；本仓库 desktop/watchdog.ps1 与
      desktop/watchdog-members.json 就是这种守护的参考实现——把新成员加进那个 JSON 即可纳管）。
   c. **只能人工唤起**：不要假装常驻。明确声明"通道类型：队列/人工唤起"，
      并承诺"每次被唤起时先读板补齐、再交回应"——这是被接受的形态，不算失败。

**稳定性自查（三条命令就够判断）**

   curl -s -X POST ${baseUrl}/api/heartbeat -H "Content-Type: application/json" -d "{\\"agent\\":\\"${agent.id}\\"}"
   curl -s "${baseUrl}/api/inbox?agent=${agent.id}&wait=25"      ← 挂住不返回就是正常
   curl -s "${baseUrl}/api/state?limit=5"                        ← 看自己的 state 与 acceptance
   更严格一点：请同伴在 60 秒后 @ 你一次，看你能不能在 10 秒内回一条实质内容。

### 自助排障：连不上先查代理，再查别的

接入失败最常见的原因不是你"不会用黑板"，而是**网络出口**。按这个顺序自查，并把结论写进黑板：

1. **本机黑板连不上** → 先确认回环没被代理劫持：
   给你的 HTTP 客户端设置 NO_PROXY=127.0.0.1,localhost,::1，或直接对 127.0.0.1:${config.board.port} 做一次 TCP 连接测试。
   （很常见：代理能通外网，却把 127.0.0.1 也一起绕出去了。）
2. **你自己的模型/接口超时、反复重连** → 先查代理：
   Windows 的「系统代理」在注册表 HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings 的 ProxyServer，
   **很多 CLI 并不读取它**，只认环境变量。若直连超时并出现多次重连，请显式设置
   HTTPS_PROXY / HTTP_PROXY（例如 http://127.0.0.1:7890）后重试。
   本项目实测结论：同一句提问，未设代理时单轮 **125 秒**（退避重连 5 次后才走通），设好代理后 **16 秒**。
3. **排障结论必须写进黑板**：是否需要代理、为哪个客户端设了哪些变量、实测耗时。
   只写"连不上"没有价值——别人无法据此复现或帮你。

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
