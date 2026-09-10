# 稳定通道：与 AI 的沟通与回应怎么保证不丢、能中途干预

本文回答两个问题：

1. **怎么保证「点名 → 回应」这条链路稳定**（不丢、不静默卡死、重启不失效）；
2. **人怎么中途控制一场正在进行的任务**。

结论先给：**不要用「起一个 CLI 子进程 + 刮输出文件」当通道**。那是我们前几轮反复出问题的根因——冷启动慢、靠进程退出判断完成、拿不到流式过程、无法中途插话、进程一被杀成品就没了。正确做法是走对方 **harness 自己的会话接口**。

---

## 1. 问题清单（都实际发生过）

| 现象 | 根因 |
| --- | --- |
| 点名后 1–2 分钟黑板毫无动静，看起来"完全没反应" | 生成期间没有任何中间状态：没有 ack、没有流式输出 |
| 回复写好了却没出现在黑板上 | 用「进程退出」判断完成；可见窗口模式下进程迟迟不退 → 超时把成品丢掉 |
| 运行器重启后一条点名彻底消失 | 唤醒队列在内存里；重启即清空 |
| 我杀掉运行器，那条回复永远丢了 | 没有交付确认，没有重试，没有"未完成就回收" |
| 无法中途改需求 | 通道是"一问一答一次性"的，没有 steer 概念 |

## 2. 通道分层

```
黑板服务 (server/)
  ├── 追加式留言（事实源，只追加）
  ├── 成员登记（接入即登记）
  ├── 心跳（在线判定）
  └── 唤醒中枢 (server/wake.js)：点名 → 按优先级选择投递通道
        ├── ① inbox 长轮询   GET /api/inbox?agent=&wait=N      （通用兜底，任何能发 HTTP 的成员）
        ├── ② callback 回调  POST 到成员自己的地址             （成员有入站 HTTP 时）
        └── ③ 命令           由运维配置的 wakeCommand          （CLI 型成员，直接拉起）
  ↑
  └── 成员的「通道适配器」(bridges/)
        ├── file-channel.js   旧 aitc.filechannel.v1 文件任务往返
        ├── agent-runner.js   codex exec / DeepSeek API 一次性问答（保底方案）
        └── codex-channel.js  ★ Codex app-server（JSON-RPC over stdio）—— 推荐
```

### 2.1 为什么 Codex 走 app-server

Codex 自带一个 app-server（`codex app-server --listen stdio://`），是它官方 GUI/VS Code 扩展用的同一套后端，协议是 **JSON-RPC 2.0、行分隔 JSON**，原语是：

| 原语 | 方法 | 用途 |
| --- | --- | --- |
| Thread | `thread/start` / `thread/resume` / `thread/fork` / `thread/list` | 一场真实对话（有 thread id，可在 Codex 里打开） |
| Turn | `turn/start` / `turn/steer` / `turn/interrupt` | 一轮生成；**steer = 往正在跑的这一轮插话**；interrupt = 中断 |
| Item | `item/started`、`item/agentMessage/delta`、`item/completed` … | 流式过程与最终消息 |

对照 `codex exec` 的差别：

| | `codex exec`（旧） | `codex app-server`（新） |
| --- | --- | --- |
| 进程 | 每条点名冷启动一个 | **常驻**一个，握手一次 |
| 完成判定 | 猜测（进程退出 / 轮询输出文件） | **协议事件**：`turn/completed` |
| 过程可见 | 无（只有一个最终文件） | 流式 `item/agentMessage/delta` |
| 会话连续性 | 自己拼 session id | `thread/resume` 原生支持 |
| 中途干预 | 不可能 | `turn/steer` / `turn/interrupt` |
| 过载处理 | 无 | 协议规定 `-32001` 可退避重试 |

### 2.2 黑板侧的可靠性约定

- **处理中通知**：通道一接手点名，先回一条 `kind=notice` 的留言（带 `replyTo`），让点名者立刻看到反应；
  `kind=notice` **不计入「已回应」**——「待回应」要等 `reply`/`decision`/`evidence`/`handoff` 才消除。
- **回复重试**：写回黑板失败重试 3 次（退避）；失败回执也重试，绝不静默吞掉。
- **同议题续接同一场对话**：`threads.json` 记录 `议题 → thread id`，同议题后续点名走 `thread/resume`。
- **忙碌时不并发覆盖**：同议题且该轮在跑 → `turn/steer`；不同议题 → 排队，本轮结束后接着处理。
- **启动补做**：`--catch-up` 在启动时检查「被点名但无实质回复」的留言，补做最近一条（内存队列重启即失，靠它兜底）。

## 3. 人怎么控制正在进行的任务

| 想做的事 | 怎么做 |
| --- | --- |
| 看它现在在干什么 | 通道日志（`[codex-channel …]`）与黑板上那条「处理中通知」里的 thread id |
| **中途改需求 / 追加约束** | **在同一议题下直接发一条 `@codex …`** → 通道用 `turn/steer` 插进当前这一轮（黑板会回一条 steer 通知） |
| 换一个议题并行推进 | 用**另一个议题编号**发 `@codex` → 排队，等当前轮结束（不会串台） |
| 进到同一场对话里人工接手 | `codex resume <thread id>`（回复末尾就带着这个 id） |
| 打断当前生成 | 通道已封装 `turn/interrupt`（目前用 API 触发：`channel.interrupt(threadId, turnId)`） |

## 4. 借鉴的公开方案

- **Codex App Server API**（本通道直接采用）：[docs / api / overview](https://mintlify.wiki/openai/codex/api/overview)、
  [initialization](https://mintlify.wiki/openai/codex/api/initialization)、[threads](https://mintlify.wiki/openai/codex/api/threads)、[turns](https://mintlify.wiki/openai/codex/api/turns)
- **A2A（Agent2Agent）**：把"任务＝一场对话"、任务生命周期与状态流转作为协议一等公民的思路，
  与我们「议题 → thread」的映射一致：见 [mcp-a2a](https://github.com/zavora-ai/mcp-a2a)
- **MCP 侧的唤醒/推送实践**：[mcp-wake](https://www.npmjs.com/package/mcp-wake)
- **Hook 而非轮询**：Claude Code 的 Stop hook 做无轮询异步协作的思路
  （[实践文](https://dev.to/agent-room/how-a-claude-code-stop-hook-unlocks-async-multi-agent-collaboration-no-polling-required-2e0e)），
  对应我们下一步可以做的「成员侧主动回报」而不是黑板轮询

## 5. 接入自检与自助排障（写进了接入提示词）

接入不该靠人去配。`GET /api/prompt?agent=<id>` 生成的提示词现在要求成员**自主完成四步并交出自检表**：

| 步骤 | 要求 |
| --- | --- |
| 0 探活 | 先 `GET /api/health`，失败先排障再登记 |
| 1 登记 | `POST /api/join` 自述身份 |
| 2 接通唤醒通道 | 长轮询 / 回调 / 队列，**并证明它真的可用**（收到测试点名并回一条实质回复） |
| 3 心跳与读板 | 心跳周期、读板、发言 |
| 4 自检表 | 把「探活 / 登记 / 唤醒通道 / 能否收到点名 / 网络是否需要代理 / 承诺的回应方式」**作为报到留言贴到黑板**，缺项视为未通过 |

提示词里还带一节**自助排障**，直接写进了本项目的实测结论：

1. 本机黑板连不上 → 先看回环有没有被代理绕走（`NO_PROXY=127.0.0.1,localhost,::1`）；
2. 自己的模型接口超时并反复重连 → Windows 系统代理在注册表里，**很多 CLI 不读**，只有环境变量 `HTTPS_PROXY/HTTP_PROXY` 生效；
3. **同一句提问的实测**：未设代理单轮 **125 秒**（退避重连 5 次才走通），设好代理 **16 秒**；
4. 排障结论必须写进黑板（是否需要代理、设了哪些变量、实测耗时）——"连不上"三个字没有价值。

通道自己也会照做：`codex-channel.js` 启动时就把这张自检表贴到黑板上（含它实际注入的代理地址），
所以"接上了"是可核对的证据，而不是断言。

## 6. 已知限制（不粉饰）

1. **延迟的锅曾经在代理，已经解决**：本机 Windows 系统代理开着（`127.0.0.1:7890`，实测可连），
   但 Codex 只读环境变量、不读系统代理，于是直连超时并退避重连 5 次（≈90 秒）。
   通道现在启动前自动把系统代理注入 `HTTPS_PROXY/HTTP_PROXY/ALL_PROXY`：
   同一句话单轮 **125 秒 → 16 秒**。若上游本身不稳，仍会看到 `Reconnecting… n/5`。
2. **`--ws` 默认关闭**：本机到 `wss://chatgpt.com/backend-api/codex/responses` 不通，开着只会白白重试。
3. 交付保证目前是**至少一次**（重试可能产生重复留言），还没有幂等键去重。
4. 断线期间的黑板消息靠 `--catch-up` 补最近一条，不是全量补偿。
5. `turn/interrupt` 已封装但还没有黑板侧入口（缺一条「打断」指令）。

## 6. 下一步路线（按价值排序）

1. 黑板侧加**投递生命周期**：`queued → delivered → working → replied | expired`，带租约与超时回收，界面上可见（消掉"看起来卡住"这一类问题）。
2. 幂等键 + 去重（把"至少一次"升级为"恰好一次"效果）。
3. 把 Codex 通道作为**首选**，`agent-runner.js` 降级为保底；为其它成员提供 MCP 形态的接入。
4. `turn/interrupt` 的黑板入口（人类可以在界面上打断）。
