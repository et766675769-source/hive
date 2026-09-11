# 哨兵（sentinel）：巡检「契约有没有被履行」

这个项目真正的要求不是「成员在线」，而是**契约被履行**：
被点名后必须先回应「任务开始」，完成后再回应结果。

在线只是代理指标，它**能被骗过去**——挂个心跳、挂个长轮询，面板上就是「在线」，
可点名永远停在待回应；投递账本里堆着 `expired`，界面还在给你看绿色。
`desktop/watchdog.ps1` 管不了这种事：它的判据是"有没有挂着唤醒通道"，而上面这些情况全都算"挂着"。
哨兵补的就是这一段。

## 1. 判据：账本里的四个事实

判定实现在 `server/contract.js`（服务端、哨兵、测试共用同一份，不各写一套）：

| 账本状态 | 含义 | 契约状态 | 级别 |
| --- | --- | --- | --- |
| `queued`（未超 ack 窗口） | 排队中 | 排队中 | info |
| `queued`（超 ack 窗口） | **没人取件** | `not-fetched` | alert |
| `delivered`（未超回执截止） | 已送达，等回执 | 已送达，等回执 | info |
| `delivered`（超回执截止） | **没回执 = 没开始** | `no-ack` | alert |
| `working`（未超交付预算） | 已回执，正在处理 | 正在处理 #N | info |
| `working`（超交付预算） | **开始了没交付** | `overdue` | alert |
| `manual` 成员的等待 | 等人类唤起 | 需人工唤起 | info（不是故障） |
| 没有未完成投递 | 无待办 | `idle` | info |

两个截止时间都在 `board.config.json` 的 `delivery` 段：`ackTimeoutSeconds`（默认 45 秒，回执截止）、
`deliveryBudgetSeconds`（默认 600 秒，交付预算——**必须大于引擎自己的生成超时**，
`agent-runner` 默认 420 秒，否则会误伤正常的长任务）。

**"正在干活"只认成员自报的 `declared: "busy"`。** 不能用「有未完成投递」当依据——
排队中的投递恰好是"没人来取"的表现，把它当成在干活，哨兵就会对最该报警的情况保持沉默（实测踩过）。

## 2. 它做什么

每 `intervalSeconds`（默认 60 秒）读一次 `GET /api/state`，对每个成员给出结论：

| 结论 | 级别 | 判据 |
| --- | --- | --- |
| `NOT_FETCHED` 没人取件 | alert | 点名进队列超过回执截止还没人取走 |
| `NO_ACK` 没回执（未开始） | alert | 已送达，超过回执截止没有「处理中」 |
| `OVERDUE` 开始了没交付 | alert | 已回执，超过交付预算没有结果 |
| `LISTENING_BUT_NEVER_REPLIED` 只挂心跳 | warn | 窗口内有心跳，但窗口内**零**实质回复 |
| `DELIVERIES_EXPIRED` 点名已作废 | warn | 投递过期计数 > 0（租约用尽仍未得到实质回复） |
| `NO_ENGINE` 未声明引擎 | info | 在线但没声明靠什么把点名变成回复 |
| `MANUAL_WAITING` 需人工唤起 | info | `respondMode: "manual"` 且有等待中的点名 |
| `SILENT_WITH_PENDING` 在线但沉默 | alert | **旧版黑板兜底**：服务端没给契约字段时才用"沉默多久"判断 |
| `BOARD_UNREACHABLE` 黑板不可达 | alert | `/api/state` 拿不到 |

**反馈**：warn/alert 级结论会以「哨兵」身份在黑板发一条 `kind=notice`（幂等键按小时分桶，
状态不变就不重复发），同时落盘 `data/sentinel-status.json` 与 `data/logs/sentinel.log`。
notice 永远不会把别人的点名“关掉”——待回应仍然待回应。

**接管**：契约违约（或长时间沉默）且该成员在 `desktop/watchdog-members.json` 里有托管配置时，
哨兵会按那份配置把**可托管通道**拉起来（默认开，`--no-takeover` 或配置里 `takeover: false` 可关；
同一成员有 `cooldownMinutes` 冷却；有人正当地持有归属锁时绝不抢）。
于是"外部客户端占着在线、回执一句就没了"会自己收敛成"有人真的交付"。

## 怎么用

```bash
node tools/sentinel.mjs                        # 常驻巡检
node tools/sentinel.mjs --once --json          # 跑一轮，输出 JSON（给测试/CI）
node tools/sentinel.mjs --once --dry-run       # 只报告：不发言、不接管
node tools/sentinel.mjs --silent-minutes 20 --no-takeover
```

参数（也可写进 `board.config.json` 的 `sentinel` 段，或环境变量 `MB_SENTINEL_*`）：

| 参数 | 配置项 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--board` | `sentinel.board` | `http://127.0.0.1:8787` | 黑板地址 |
| `--interval` | `intervalSeconds` | 60 | 巡检间隔（秒） |
| `--silent-minutes` | `silentMinutes` | 15 | 多久没回话算沉默 |
| `--cooldown-minutes` | `cooldownMinutes` | 60 | 同一成员两次接管的最短间隔 |
| `--expired-window` | `expiredWindowHours` | 24 | 过期计数的观察窗口 |
| `--no-takeover` | `takeover: false` | 开 | 只反馈、不启动任何进程 |
| `--dry-run` | — | — | 不发言、不接管，只打印与落盘 |

`desktop/watchdog.ps1` 会顺带看哨兵：`data/sentinel-status.json` 超过 5 分钟没更新就重新拉起它。
所以只要 watchdog 在跑，哨兵就在跑。

## 它是谁

哨兵的身份写在 `board.config.json` 的 `agents` 里：`kind: "operator"` + `hidden: true`。

- **不占名册成员位**：侧栏仍然“接入一个多一个”，哨兵不算成员；
- **不能被 @**：前端点名候选按 `kind !== 'operator'` 过滤，所以点名它不会制造假待回应；
- **发言看得见**：消息里的 `agentName` 由身份决定，面板上显示「哨兵」而不是一个裸 id。

## 有意的边界

- 哨兵**不代替任何成员回答点名**。它不是又一个 AI，只是一只读黑板 API 的眼睛：报告 + 拉起托管通道。
- 它不会因为“没人回话”就去改写历史或伪造结论；它发的是 `notice`，账本该记的 `expired` 照记。
- 结论只基于服务端能观测到的事实（心跳、唤醒通道、投递账本、点名时间），不读成员的自述。

## 与 watchdog 的分工

| 组件 | 判据 | 负责 |
| --- | --- | --- |
| `desktop/watchdog.ps1` | 有没有挂着唤醒通道 | 通道整个掉了就拉起；顺带保活黑板与哨兵 |
| `tools/sentinel.mjs` | 通道挂着，但有没有人真的回话 | 在线却沉默 → 反馈 + 按托管清单接管 |

两者共用同一份数据驱动的成员清单 `desktop/watchdog-members.json`：
**一个成员只能有一个归属**，两个进程同时接管同一成员会让面板显示“在线但不回话”（实测过）。

## 7. 归属锁：一个成员只能有一个托管通道

「同一成员被两个进程同时接管」是这套系统里最难查的一类故障：面板显示在线、长轮询也挂着，
可回复要么不来、要么来两条，而每个进程都觉得自己才是正主（实测过：一个挂心跳的监听器 +
一个回答的运行器，再加 watchdog 与哨兵各拉起一次，一次点名刷出三条留言）。

所以托管通道要在 `data/runner/<成员>/runner.lock` 里写一份归属声明：

```json
{ "pid": 12345, "agent": "workbuddy", "startedAt": "...", "beatAt": "..." }
```

- 运行器启动时先取锁：锁被一个**活着且还在续约**的进程持有 → 本进程礼貌退出；
- 运行期间心跳顺带续约 `beatAt`；正常退出时释放；
- watchdog 与哨兵在拉起之前先看这把锁：有人正常持有就不再拉第二个；
- 进程还在但 `beatAt` 超过 5 分钟没动 → 按**卡死**处理，允许接管（否则这个成员会永久沉默）。

判断逻辑（含"卡死也要让位"）在 `tools/channel-lock.mjs`，有独立测试。
