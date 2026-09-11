# WorkBuddy 可托管通道（最小骨架）

## 目标

让 `workbuddy` 有一个可由哨兵/看门进程启动的稳定入口，并复用现有 `bridges/agent-runner.js` 的黑板协议实现：长轮询、状态续租、幂等回复、失败回执和重启补做。

## 本轮取舍

- 新增 `workbuddy/run.mjs`，只负责固定 WorkBuddy 身份并启动通用运行器；不复制协议，也不引入运行时依赖。
- 默认引擎为 `codex-cli`；可用 `WORKBUDDY_ENGINE=rule-based` 做无模型链路自检，或命令行传入 `--engine` 覆盖。
- 不改 `desktop/watchdog-members.json`、哨兵或核心文件，因此本轮入口可以运行，但哨兵不会因本目录文件自动发现它。

## 文件

- `workbuddy/run.mjs`：托管启动入口。
- `workbuddy/README.md`：方案、证据、边界和下一步。

## 如何运行

在仓库根目录执行：

```powershell
node workbuddy/run.mjs --engine rule-based --once
node workbuddy/run.mjs --engine codex-cli --wait 20
```

`MB_BOARD`、`MB_TOKEN`、`MB_ENGINE_*` 等参数仍由通用运行器读取；本文件不保存密钥、令牌或 Cookie。`--once` 仅处理一轮后退出，常驻托管不要加它。

## 已复用的实现证据

事实（代码路径相对仓库根目录）：

- `bridges/agent-runner.js:514-524`：循环调用 `GET /api/inbox?agent=...&wait=...`，收到唤醒信封后处理。
- `bridges/agent-runner.js:292-301`：生成前及每 30 秒自报 `state=busy` 与 `正在处理 #N`。
- `bridges/agent-runner.js:319-328`：成功回复带 `replyTo` 与 `idempotencyKey`。
- `bridges/agent-runner.js:380-401`：失败/中止回执说明“不是结论”或未完成；启动时 `483-504` 会补做最近一条未回应点名。

这些是源码证据，不等于本机黑板端到端已通过；仍需运行中的服务、入口进程和延迟读回共同验证。

## 未完成或不确定

- 失败/中止回执当前没有显式 `idempotencyKey`（成功回复有）；重复唤醒下的失败回执幂等需下一轮在共享运行器或服务端补齐。
- 启动补做目前只补最近一条待回应点名，不保证一次恢复全部积压。
- 因本轮只允许新增 `workbuddy/` 文件，尚未把入口加入 `desktop/watchdog-members.json`，也未验证哨兵实际拉起它。
- 未运行真实 Codex CLI、长轮询唤醒或杀进程恢复测试；不能把“入口能启动”写成“端到端通过”。

## 下一步

下一轮先补失败回执幂等键和可验证的单元/集成自检，再经授权把 `workbuddy/run.mjs` 接入托管清单，并做一次真实点名、busy 续租、回复与重启 catch-up 验证。
