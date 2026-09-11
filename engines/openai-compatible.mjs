// 引擎：openai-compatible —— 任何 OpenAI 兼容的 /chat/completions 端点
//
// 这一层是"厂商无关"的关键：DeepSeek、OpenAI、Moonshot、通义、vLLM、one-api，
// 以及本机 Ollama / LM Studio，说的都是同一套协议。核心不需要知道它们的名字。
//
// 配置（运行器参数 → 环境变量，前者优先）：
//   --engine-base-url  MB_ENGINE_BASE_URL / DEEPSEEK_BASE_URL / OPENAI_BASE_URL
//   --engine-key       MB_ENGINE_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY
//   --engine-model     MB_ENGINE_MODEL / --model
//
// 本机模型（不需要密钥）示例：
//   --engine openai-compatible --engine-base-url http://127.0.0.1:11434/v1 --engine-model qwen2.5:7b

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SYSTEM = (ctx) =>
  `你是本地协作黑板「Message Board」上的成员：${ctx.identity?.name || ctx.agent}（id: ${ctx.agent}）。` +
  '直接给出可核验的答复，先结论、再依据、最后下一步；不夸大状态，不编造未验证的事实。';

/** 密钥来源：显式参数 → 环境变量 → dsh 凭证文件（只读，不外传）。 */
function readKey(ctx = {}) {
  const explicit = ctx.apiKey || ctx.env?.MB_ENGINE_KEY || '';
  if (explicit) return String(explicit).trim();
  for (const name of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY']) {
    const value = (ctx.env?.[name] || process.env[name] || '').trim();
    if (value) return value;
  }
  const candidates = [
    path.join(process.env.APPDATA || '', 'dsh-desktop-home', '.credentials.yaml'),
    path.join(os.homedir(), '.dsh', '.credentials.yaml'),
  ];
  for (const file of candidates) {
    try {
      const match = fs.readFileSync(file, 'utf8').match(/^\s*([A-Z_]*API_KEY)\s*:\s*(\S+)\s*$/m);
      if (match) return match[2].trim().replace(/^["']|["']$/g, '');
    } catch {
      /* 继续找下一个 */
    }
  }
  return '';
}

function baseUrl(ctx = {}) {
  const raw =
    ctx.baseUrl ||
    ctx.env?.MB_ENGINE_BASE_URL ||
    ctx.env?.DEEPSEEK_BASE_URL ||
    process.env.MB_ENGINE_BASE_URL ||
    process.env.DEEPSEEK_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    'https://api.deepseek.com';
  const url = String(raw).replace(/\/+$/, '');
  return url.endsWith('/chat/completions') ? url : `${url}/chat/completions`;
}

export const openaiCompatible = {
  meta: {
    id: 'openai-compatible',
    label: 'OpenAI 兼容接口',
    kind: 'http',
    aliases: ['http', 'api', 'deepseek-api', 'deepseek', 'openai', 'ollama'],
    summary: '调用任意 OpenAI 兼容的 /chat/completions（云端或本机 Ollama/LM Studio 均可）',
    requires: ['可访问的 base url；云端服务需要 API key'],
  },

  async health(ctx = {}) {
    const endpoint = baseUrl(ctx);
    const key = readKey(ctx);
    const model = ctx.model || ctx.env?.MB_ENGINE_MODEL || '（未指定）';
    if (!key && /api\.deepseek\.com|api\.openai\.com/.test(endpoint)) {
      return { ok: false, detail: `没有找到 API key（${endpoint}，model=${model}）` };
    }
    return { ok: true, detail: `已配置 ${endpoint}（model=${model}${key ? '' : '，无密钥'}）` };
  },

  async run(prompt, ctx = {}) {
    const endpoint = baseUrl(ctx);
    const key = readKey(ctx);
    const model = ctx.model || ctx.env?.MB_ENGINE_MODEL || 'deepseek-chat';
    const timeoutMs = Number(ctx.timeoutMs) > 0 ? Number(ctx.timeoutMs) : 120000;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs);
    if (ctx.signal) {
      if (ctx.signal.aborted) controller.abort(new Error('aborted'));
      else ctx.signal.addEventListener('abort', () => controller.abort(new Error('aborted')), { once: true });
    }

    const headers = { 'Content-Type': 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM(ctx) },
            { role: 'user', content: prompt },
          ],
          max_tokens: Number(ctx.maxTokens) > 0 ? Number(ctx.maxTokens) : 900,
          temperature: 0.3,
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`接口返回 ${response.status}：${(await response.text()).slice(0, 200)}`);
      }
      const body = await response.json();
      const text = (body?.choices?.[0]?.message?.content || body?.message?.content || '').trim();
      if (!text) throw new Error('接口返回了空回复');
      return { text, sessionId: '' };
    } catch (error) {
      if (ctx.signal?.aborted) throw new Error('aborted: 已按控制指令中断本轮生成');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  },
};
