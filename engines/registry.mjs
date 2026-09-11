// Message Board · 引擎注册表
//
// 核心与"用什么 AI 回答"是两件事。
// 黑板核心 = 服务端 + 协议 + 投递账本 + 唤醒通道；它只认识「点名」和「回复」，
// 完全不认识 Codex、DeepSeek 或任何厂商。把点名变成回复的那一层叫「引擎」（engine）。
//
// 因此：没有 Codex CLI，通信照常进行 —— 换成 openai-compatible、command、rule-based
// 甚至 human（纯人工）都能跑。引擎是插槽，不是前提。
//
// 引擎接口（约定面，只有三个入口）：
//   meta  = { id, label, kind: 'local'|'cli'|'http'|'human', summary, requires: [] }
//   run(prompt, ctx) -> string | { text, sessionId? }
//   health(ctx)      -> { ok: boolean, detail: string }        （可选，用于自检）
//
// ctx = {
//   agent, identity, sessionId, signal, workdir, sandbox,
//   timeoutMs, model, runtimeDir, env, log, fetchImpl
// }
//
// 写自己的引擎：照 engines/README.md 放一个 .mjs 导出 meta + run，然后
//   register(myEngine)
// 或让运行器用 --engine-file <路径> 加载。核心代码不需要任何改动。

import { ruleBased } from './rule-based.mjs';
import { command } from './command.mjs';
import { openaiCompatible } from './openai-compatible.mjs';
import { codexCli } from './codex-cli.mjs';
import { human } from './human.mjs';

const engines = new Map();
const aliases = new Map();

function assertShape(engine) {
  const meta = engine && engine.meta;
  if (!meta || typeof meta.id !== 'string' || !meta.id) {
    throw new Error('引擎缺少 meta.id');
  }
  if (typeof engine.run !== 'function') {
    throw new Error(`引擎 ${meta.id} 缺少 run(prompt, ctx)`);
  }
  return engine;
}

/** 注册一个引擎；重复 id 覆盖（方便运行器用本地实现替换内置实现）。 */
export function register(engine) {
  assertShape(engine);
  engines.set(engine.meta.id, engine);
  for (const alias of engine.meta.aliases || []) aliases.set(alias, engine.meta.id);
  return engine.meta.id;
}

export function listEngines() {
  return [...engines.values()].map((engine) => ({ ...engine.meta }));
}

export function hasEngine(id) {
  const key = String(id || '').trim().toLowerCase();
  return engines.has(key) || aliases.has(key);
}

/** 解析引擎 id（含别名）。解析不到时抛出带可选清单的错误，方便排障。 */
export function resolveEngine(id) {
  const key = String(id || '').trim().toLowerCase();
  if (!key) throw new Error(`未指定引擎；可用引擎：${[...engines.keys()].join(', ')}`);
  const resolved = engines.get(key) || engines.get(aliases.get(key));
  if (!resolved) {
    throw new Error(`未知引擎「${id}」；可用引擎：${[...engines.keys()].join(', ')}`);
  }
  return resolved;
}

/** 由引擎自己描述"能不能用"，而不是由核心猜。 */
export async function checkEngine(id, ctx = {}) {
  const engine = resolveEngine(id);
  if (typeof engine.health !== 'function') return { engine: engine.meta.id, ok: true, detail: '该引擎未提供自检' };
  try {
    const result = await engine.health(ctx);
    return { engine: engine.meta.id, ok: result?.ok !== false, detail: result?.detail || '' };
  } catch (error) {
    return { engine: engine.meta.id, ok: false, detail: error.message };
  }
}

/** 统一入口：核心只调用它，不关心背后是谁。 */
export async function runEngine(id, prompt, ctx = {}) {
  const engine = resolveEngine(id);
  const result = await engine.run(prompt, ctx);
  if (typeof result === 'string') return { text: result, sessionId: ctx.sessionId || '' };
  if (result && typeof result.text === 'string') return { text: result.text, sessionId: result.sessionId || ctx.sessionId || '' };
  throw new Error(`引擎 ${engine.meta.id} 没有返回文本`);
}

// ── 内置引擎（零依赖）──────────────────────────────────────
// 顺序即立场：从"不需要任何 AI"到"需要外部服务"。
// 没有 Codex CLI、没有任何模型，前两个照样让黑板通信闭环。
for (const engine of [ruleBased, command, openaiCompatible, codexCli, human]) register(engine);

export { ruleBased, command, openaiCompatible, codexCli, human };
