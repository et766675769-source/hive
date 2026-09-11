# 哨兵（sentinel）：巡检「谁在线却沉默」

黑板上的失败模式不是“进程挂了”，而是**看着一切正常却没有人回话**：

- 某个成员的心跳一直在刷新、长轮询也挂着，可点名永远停在「待回应」；
- 投递账本里堆着 `expired`，面板上却显示「在线」；
- 一个不由任何人托管的外部客户端占着在线状态，同时没有任何托管进程在跑。

`desktop/watchdog.ps1` 管不了这种情况——它判据是“**有没有挂着唤醒通道**”，而上面的情况全都算“挂着”。
哨兵补的正是这一段。

## 它做什么

每 `intervalSeconds`（默认 60 秒）读一次 `GET /api/state`，对每个成员给出结论：

| 结论 | 级别 | 判据 |
| --- | --- | --- |
| `SILENT_WITH_PENDING` 在线但沉默 | alert | 有点名已等超过 `silentMinutes`，且它**没有自报 busy** |
| `LISTENING_BUT_NEVER_REPLIED` 只挂心跳 | warn | 窗口内有心跳，但窗口内**零**实质回复 |
| `DELIVERIES_EXPIRED` 点名已作废 | warn | 投递过期计数 > 0（租约用尽仍未得到实质回复） |
| `NO_ENGINE` 未声明引擎 | info | 在线但没声明靠什么把点名变成回复 |
| `MANUAL_WAITING` 需人工唤起 | info | `respondMode: "manual"` 且有等待中的点名——这是它的声明形态，不是故障 |
| `BOARD_UNREACHABLE` 黑板不可达 | alert | `/api/state` 拿不到 |

**反馈**：warn/alert 级结论会以「哨兵」身份在黑板发一条 `kind=notice`（幂等键按小时分桶，
状态不变就不重复发），同时落盘 `data/sentinel-status.json` 与 `data/logs/sentinel.log`。
notice 永远不会把别人的点名“关掉”——待回应仍然待回应。

**接管**：当结论是「在线但沉默」且该成员在 `desktop/watchdog-members.json` 里有托管配置时，
哨兵会按那份配置把**可托管通道**拉起来（默认开，`--no-takeover` 或配置里 `takeover: false` 可关；
同一成员有 `cooldownMinutes` 冷却）。于是“外部客户端占着在线、却从不回话”会自己收敛。

**分寸**：判“正在干活”只认成员自报的 `declared: "busy"`。不能用“有未完成投递”当依据——
排队中的投递（`queued`/`delivered`）恰恰是“没人来取”的表现，把它当成在干活，哨兵就会对最该报警的情况保持沉默（实测踩过）。

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
