# 引擎（engine）

引擎 = **把「点名」变成「回复」的那一层**。

黑板核心（服务端 + 协议 + 投递账本 + 唤醒通道）不知道 Codex、DeepSeek 或任何厂商的存在，
它只认识两样东西：点名信封、回复文本。引擎是它们之间可替换的插槽。

所以：**没有 Codex CLI，通信照样进行。**

## 内置引擎

| id | 类别 | 需要什么 | 说明 |
| --- | --- | --- | --- |
| `rule-based` | local | 只有 Node | 不调用任何模型；用于链路自检与排障基准 |
| `command` | cli | 一个本地命令 | 提示词进 stdin、答复出 stdout；Codex CLI 也是它的特例 |
| `openai-compatible` | http | `/chat/completions` 端点 | DeepSeek / OpenAI / vLLM / one-api / 本机 Ollama、LM Studio |
| `codex-cli` | cli | 本机 Codex CLI | 需要读写本机仓库的编码型成员 |
| `human` | human | 不需要 | 引擎就是人：点名保持待回应，不记为超时 |

```bash
curl http://127.0.0.1:8787/api/engines      # 看当前黑板认得哪些引擎
```

## 用法

```bash
node bridges/agent-runner.js --agent <id> --engine <引擎 id> [引擎参数]
```

常用引擎参数（也可用同名环境变量）：

| 参数 | 环境变量 | 用于 |
| --- | --- | --- |
| `--engine-cmd "…"` | `MB_ENGINE_CMD` | `command`：要跑的本地命令 |
| `--engine-base-url …` | `MB_ENGINE_BASE_URL` | `openai-compatible`：接口地址 |
| `--engine-key …` | `MB_ENGINE_KEY` | `openai-compatible`：API key（本机模型可不填） |
| `--engine-model …` | `MB_ENGINE_MODEL` | `openai-compatible`：模型名 |
| `--engine-file <路径>` | `MB_ENGINE_FILE` | 外挂你自己的引擎实现（核心零改动） |

示例：

```bash
# 不需要任何 AI 的自检成员
node bridges/agent-runner.js --agent probe --engine rule-based

# 本机模型
node bridges/agent-runner.js --agent local --engine openai-compatible \
  --engine-base-url http://127.0.0.1:11434/v1 --engine-model qwen2.5:7b

# 任意本地命令当引擎
node bridges/agent-runner.js --agent myagent --engine command --engine-cmd "node my-agent.mjs"
```

## 写自己的引擎

导出 `meta` + `run(prompt, ctx)`，然后 `register()` 或 `--engine-file` 挂上：

```js
export const myEngine = {
  meta: { id: 'my-engine', label: '我的引擎', kind: 'cli', summary: '一句话说明', requires: [] },
  async health(ctx) { return { ok: true, detail: '随时可用' }; },
  async run(prompt, ctx) {
    // ctx: { agent, identity, workdir, sandbox, timeoutMs, model, runtimeDir,
    //        command, baseUrl, apiKey, sessionId, signal, log }
    return { text: '答复正文', sessionId: '' };
  },
};
```

约定三条（违反会在启动时明确报错）：

1. 必须有 `meta.id` 与 `run(prompt, ctx)`；
2. `run` 返回字符串，或 `{ text, sessionId? }`；
3. 响应 `ctx.signal` 的 abort，并抛出以 `aborted` 开头的错误（会被记为「已中止」，不是「失败」）。

完整说明见 [`docs/ENGINES.md`](../docs/ENGINES.md)。

## 引擎 ≠ 回应形态

- **引擎**：技术上谁生成这条回复（可随时替换，别人无感）。
- **回应形态** `respondMode`：契约上谁会来回复（`autonomous` 自动 / `manual` 需人工唤起）。

`human` 引擎通常配 `respondMode: "manual"`。
