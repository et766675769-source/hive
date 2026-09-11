// 引擎：command —— 任何"读提示词、写答复"的本地程序都能当引擎
//
// 这是最通用的一层：把提示词从 stdin 交给一个子进程，读它的 stdout 当回复。
// 于是 Codex CLI、Claude Code、aider、本地脚本、甚至一个 shell 函数都是合法引擎，
// 核心不需要为任何一家写一行代码。
//
// 用法：
//   --engine command --engine-cmd "codex exec --skip-git-repo-check -"
//   --engine command --engine-cmd "node my-agent.mjs" --engine-arg=--fast
//   环境变量 MB_ENGINE_CMD 同样生效。

import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 420000;

function timeoutOf(ctx) {
  return Number(ctx.timeoutMs) > 0 ? Number(ctx.timeoutMs) : DEFAULT_TIMEOUT_MS;
}

export const command = {
  meta: {
    id: 'command',
    label: '本地命令引擎',
    kind: 'cli',
    aliases: ['cmd', 'shell', 'cli'],
    summary: '把提示词从 stdin 交给任意本地命令，读取它的 stdout 作为回复（可承载 Codex CLI 等所有命令行 agent）',
    requires: ['--engine-cmd 指定的命令必须存在于本机'],
  },

  async health(ctx = {}) {
    const cmd = ctx.command || ctx.env?.MB_ENGINE_CMD || '';
    if (!cmd) return { ok: false, detail: '未指定命令：需要 --engine-cmd "..." 或 MB_ENGINE_CMD' };
    try {
      const first = String(cmd).trim().split(/\s+/)[0];
      const probe = spawn(first, ['--version'], { shell: false, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
      const ok = await new Promise((resolve) => {
        probe.on('error', () => resolve(false));
        probe.on('exit', () => resolve(true));
        setTimeout(() => {
          try {
            probe.kill();
          } catch {
            /* 忽略 */
          }
          resolve(true);
        }, 4000);
      });
      return ok ? { ok: true, detail: `命令可执行：${first}` } : { ok: false, detail: `找不到命令：${first}` };
    } catch (error) {
      return { ok: false, detail: error.message };
    }
  },

  run(prompt, ctx = {}) {
    const cmd = ctx.command || ctx.env?.MB_ENGINE_CMD || '';
    if (!cmd) throw new Error('未指定命令：需要 --engine-cmd "..." 或环境变量 MB_ENGINE_CMD');
    const cwd = ctx.workdir || process.cwd();
    const log = typeof ctx.log === 'function' ? ctx.log : () => {};

    return new Promise((resolve, reject) => {
      const child = spawn(cmd, {
        cwd,
        shell: true,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, MB_AGENT: ctx.agent || '', ...(ctx.env || {}) },
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill();
        } catch {
          /* 忽略 */
        }
        reject(new Error(`命令引擎超时（${timeoutOf(ctx) / 1000}s）：${cmd}`));
      }, timeoutOf(ctx));

      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => finish(error));
      child.on('exit', (code) => {
        const text = stdout.trim();
        if (text) {
          finish(null, text);
          return;
        }
        finish(new Error(`命令引擎退出码 ${code} 且没有输出${stderr.trim() ? `：${stderr.trim().slice(0, 300)}` : ''}`));
      });

      if (ctx.signal) {
        const onAbort = () => {
          try {
            child.kill();
          } catch {
            /* 忽略 */
          }
          finish(new Error('aborted: 已按控制指令中断本轮生成'));
        };
        if (ctx.signal.aborted) onAbort();
        else ctx.signal.addEventListener('abort', onAbort, { once: true });
      }

      log(`命令引擎启动：${cmd}`);
      try {
        child.stdin.end(String(prompt ?? ''), 'utf8');
      } catch (error) {
        finish(error);
      }
    });
  },
};
