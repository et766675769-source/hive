# 交接说明（Handoff）：Message Board 当前状态与剩余工作

给接手的下一个模型 / 协作者看：这份是"继续往下做"所需的全部背景，不写过程、只写结论与坑。

## 1. 项目目标（原话，绑定）

> 面板的核心作用就是作为多 AI 的沟通桥梁，只是需要面板的沟通能给人看到，核心功能是实时协作沟通互通有无。
> AI 的回复【必须】出现在面板中，不管心跳如何设置，当点名时，点到名 AI【必须】先做出回应表示任务开始，然后完成任务后在面板中回复任务结果。

由此派生的两条工程原则，**贯穿全部代码**：

1. 判据是「契约」（点名 → 回执 → 结果），不是「在线」。心跳能被骗，契约不能。
2. 「下一个接入的 AI 可能不那么聪明」：接入路径必须是照抄就能完成的。

## 2. 架构一句话

- 核心（server/）= 服务端 + 协议 + 投递账本 + 唤醒通道，**不认识任何厂商**。
- 引擎（engines/）= 把「点名」变成「回复」的可替换插槽（rule-based / command / openai-compatible / codex-cli / human）。
- 通道（bridges/、agents/member-loop.mjs、tools/mb.js）= 常驻进程，负责心跳 + 长轮询 + 契约履行。
- 哨兵（tools/sentinel.mjs）= 巡检「契约有没有被履行」，反馈到黑板 + 按 watchdog-members.json 接管。
- 归属锁（tools/channel-lock.mjs）= 一个成员只能有一个托管通道。

关键文件：`server/contract.js`（契约判定，唯一实现）、`server/delivery.js`（投递账本）、
`tools/sentinel.mjs`、`tools/mb.js`（serve/doctor）、`agents/member-loop.mjs`（笨成员标准实现）。

## 3. 当前状态（都已验证、已提交，57 项测试通过）

- 引擎解耦：没有 Codex CLI 也能通信（rule-based / command 闭环演示过）。
- 契约判据：面板成员行显示「无待办 / 排队中 / 已送达等回执 / 正在处理 #N / 没人取件 / 没回执 / 开始了没交付 / 作废未回应 / 需人工唤起」；违约变红；头部计数「正常 N/全部」。
- 哨兵：契约违约 → 发 notice + 按托管清单拉起通道；「作废（expired）」也算违约，人类主动叫停（endedBy=interrupted）不算。
- 接入：`tools/mb.js serve <id>` 一条命令接上；`tools/mb.js doctor <id>` 自检；提示词开头「〇、最快路径」。
- 归属锁：运行器取不到锁就让位，进程卡死（5 分钟没续约）才允许接管。
- 线上（127.0.0.1:8787）三个成员 codex / deepseek / workbuddy 都在跑，契约=无待办，待回应=空。

## 4. 剩余工作（按价值排序）

1. **消测试抖动（遗留）**：投递租约类测试（leaseSeconds=1 的 3 个）用固定睡眠，满载会抖；
   契约相关两处已改成 `waitFor` 轮询，租约那几个还没改完——把它们也改成轮询等待。
2. **契约可操作化**：面板在「作废未回应 / 没回执」时给一个「重新派发」按钮（哨兵现在自动接管，
   加一个人工可确认的入口更符合"给人看到"）。
3. **阈值对齐真实节奏**：`deliveryBudgetSeconds`(600) 必须 > 引擎生成超时（agent-runner 默认 420）；
   必要时按成员自报的引擎调。
4. **codex 通道也走归属锁**：目前只有 agent-runner/member-loop 写锁；codex-channel 未接入。
5. **workbuddy 外部客户端**：它的在线状态一度由第三方长轮询维持（非我们托管），哨兵能在它沉默时接管；
   若要彻底纳入，需在其产品侧改，不在本仓。

## 5. 会反复咬人的坑（务必记住）

- **两棵树的同步方向**：`C:\Users\ET\AppData\Local\Temp\mb-src\`（staging，无 .git）是源码副本；
  `D:\DS harkness\MessageBoard\`（target，git 仓库）是交付。**改代码在 staging，单向 robocopy/Copy-Item 到 target**；
  反过来覆盖会丢代码（我至少因此丢过两次：watchdog 保活段、member-loop 的 IDENTITY 修复）。
- **Windows 编码**：记事本/PowerShell `Out-File -Encoding utf8` 写 BOM，`JSON.parse` 见 BOM 直接抛；
  `tools/sentinel.mjs` 读清单前剥 BOM。`.ps1` 必须纯 ASCII（PS 5.1 按 ANSI 读）。中文别用 `curl -d` 直发（变问号）。
- **在线 ≠ 履行**：挂个心跳就能显示在线；判"正在干活"只认成员自报 `declared: "busy"`，不能用"有未完成投递"当依据。
- **作废也是违约**：只看"未完成的投递"会让"回执一句就消失"的成员显示成「无待办」（#155 实测踩过）。
- **登记顺序**：`parseMentions` 只认可**已登记**成员；登记之前发出的 @ 不是点名（有测试锁住）。
- **跑测试**：`node test/board.test.js` 直接跑；`node --test` 在本机会 spawn EPERM。测试里 spawn 子进程用管道捕获是可行的。

## 6. 常用命令

```bash
npm start                                  # 黑板 8787
node tools/mb.js state                     # 概览
node tools/mb.js serve <id> --name 名字     # 一条命令接上成员
node tools/mb.js doctor <id>               # 接入自检
node tools/sentinel.mjs --once --json      # 哨兵单轮
node test/board.test.js                    # 57 项测试
curl http://127.0.0.1:8787/api/engines     # 引擎清单
```
