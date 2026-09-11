// 引擎：codex-cli —— 本机 Codex CLI
//
// 它是"众多引擎之一"，不是核心的前提：核心（服务端 + 协议 + 投递账本 + 唤醒通道）
// 完全不知道 Codex 的存在。把这一路删掉，黑板照样通信（见 openai-compatible / command /
// rule-based / human）。放在这里只是因为它在本机可用、且能读写仓库。
//
// 实现要点（都是踩过的坑）：
//   - 提示词从文件重定向进 stdin，回复用 -o 写到文件：全程不开命名管道（沙箱里管道会 EPERM）；
//   - 完成判定以"输出文件内容连续两次一致"为准，而不是进程退出（可见窗口的 start/wait 会拖尾）；
//   - 给了 sessionId 就走 exec resume：同一议题的后续点名续接同一次对话。
//
// 参数（由运行器通过 ctx 传入，也可用环境变量）：
//   ctx.workdir   工作目录（--workdir）        ctx.sandbox  沙箱模式（--sandbox）
//   ctx.runtimeDir 运行目录（--runtime）       ctx.visible  是否开独立终端窗口（--visible）
//   ctx.timeoutMs 超时                         ctx.sessionId 续接的会话 id

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 420000;
const SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');

const q = (value) => `"${String(value).replace(/"/g, '""')}"`;

/** 取最近一次 Codex 会话 id（rollout 文件名里带 uuid），用于回报可 resume 的会话。 */
function findLatestSessionId(sinceMs) {
  try {
    let newest = null;
    const walk = (dir, depth = 0) => {
      if (depth > 4) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.name.endsWith('.jsonl')) {
          const stat = fs.statSync(full);
          if (stat.mtimeMs >= sinceMs - 2000 && (!newest || stat.mtimeMs > newest.mtimeMs)) {
            newest = { mtimeMs: stat.mtimeMs, name: entry.name };
          }
        }
      }
    };
    if (fs.existsSync(SESSIONS_DIR)) walk(SESSIONS_DIR);
    if (!newest) return '';
    const match = newest.name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

export const codexCli = {
  meta: {
    id: 'codex-cli',
    label: 'Codex CLI',
    kind: 'cli',
    aliases: ['codex', 'codex-exec'],
    summary: '调用本机 Codex CLI（codex exec，回复写入文件而非 stdout 管道），可选独立终端窗口',
    requires: ['本机安装 codex CLI（codex --version 可用）'],
    // 支持续接同一次对话：运行器会按议题缓存 sessionId 并在下一轮传回来
    resumable: true,
  },

  async health() {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      let child;
      try {
        child = spawn('codex', ['--version'], { shell: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      } catch (error) {
        done({ ok: false, detail: `无法启动 codex：${error.message}` });
        return;
      }
      let out = '';
      child.stdout.on('data', (chunk) => {
        out += chunk.toString('utf8');
      });
      child.on('error', (error) => done({ ok: false, detail: `无法启动 codex：${error.message}` }));
      child.on('exit', () => done({ ok: true, detail: `codex 可用：${out.trim().split('\n')[0] || '（无版本输出）'}` }));
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* 忽略 */
        }
        done({ ok: false, detail: 'codex --version 超时' });
      }, 8000);
    });
  },

  run(prompt, ctx = {}) {
    const log = typeof ctx.log === 'function' ? ctx.log : () => {};
    const runtimeDir = ctx.runtimeDir || path.join(process.cwd(), 'data', 'runner');
    const workdir = ctx.workdir || process.cwd();
    const sandbox = ctx.sandbox || 'read-only';
    const timeoutMs = Number(ctx.timeoutMs) > 0 ? Number(ctx.timeoutMs) : DEFAULT_TIMEOUT_MS;
    const visible = Boolean(ctx.visible);
    const name = ctx.identity?.name || ctx.agent || 'member';
    const sessionId = ctx.sessionId || '';

    return new Promise((resolve, reject) => {
      fs.mkdirSync(runtimeDir, { recursive: true });
      const stamp = Date.now();
      const promptFile = path.join(runtimeDir, `prompt-${stamp}.txt`);
      const outFile = path.join(runtimeDir, `last-${stamp}.txt`);
      fs.writeFileSync(promptFile, prompt, 'utf8');

      // disk-full-read-access：让 Codex 能读盘上其它目录，写仍受会话沙箱限制。
      const head = ['codex', 'exec'];
      const tail = ['--skip-git-repo-check', '-c', 'sandbox_permissions=["disk-full-read-access"]'];
      if (sessionId) {
        head.push('resume');
        tail.push('-o', q(outFile), sessionId, '-', '<', q(promptFile));
        log(`续接 Codex 会话 ${sessionId}（同一议题继续同一次对话）`);
      } else {
        tail.push('-C', q(workdir), '-s', sandbox, '-o', q(outFile), '-', '<', q(promptFile));
      }
      const command = [...head, ...tail].join(' ');
      log(`调用 codex exec（sandbox=${sandbox}, cwd=${workdir}${visible ? ', 独立窗口' : ''}）`);

      const startedAt = Date.now();
      let child;
      if (visible) {
        // 独立终端窗口里跑：人能看见「新对话正在执行」，会话结束后窗口保留几秒
        const batch = path.join(runtimeDir, `run-${stamp}.cmd`);
        fs.writeFileSync(
          batch,
          `@echo off\r\ntitle Message Board - ${name}\r\n${command}\r\necho.\r\necho ---- codex exit %errorlevel% ----\r\nping -n 9 127.0.0.1 >nul\r\n`,
          'ascii',
        );
        child = spawn('cmd.exe', ['/c', 'start', '/wait', '', batch], {
          cwd: workdir,
          stdio: ['ignore', 'ignore', 'ignore'],
        });
      } else {
        child = spawn(command, {
          cwd: workdir,
          shell: true,
          stdio: ['ignore', 'ignore', 'ignore'],
          windowsHide: true,
        });
      }

      // 完成判定以「-o 输出文件写稳」为准，而不是进程退出：
      // 可见窗口模式下的 start/wait 包装、或 codex 结束后仍在收尾，都可能让进程迟迟不退。
      let settled = false;
      let lastSeen = '';
      const settle = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(poller);
        try {
          child.kill();
        } catch {
          /* 忽略 */
        }
        if (error) reject(error);
        else resolve(value);
      };

      const readOut = () => {
        try {
          if (!fs.existsSync(outFile)) return '';
          return fs.readFileSync(outFile, 'utf8').trim();
        } catch {
          return '';
        }
      };
      const done = (text) => {
        const found = findLatestSessionId(startedAt);
        if (found) log(`本次会话 id：${found}  （可在终端执行 codex resume ${found} 进入）`);
        settle(null, { text: text || '（codex 返回了空回复）', sessionId: found });
      };

      const poller = setInterval(() => {
        const text = readOut();
        if (!text) return;
        if (text === lastSeen) done(text); // 连续两次读到同样内容 = 已写完
        else lastSeen = text;
      }, 1500);
      if (typeof poller.unref === 'function') poller.unref();

      const timer = setTimeout(() => {
        const text = readOut();
        if (text) {
          log('进程未退出，但已读到完整回复，按成功处理');
          done(text);
          return;
        }
        settle(new Error(`codex exec 超时（${timeoutMs / 1000}s），且没有产生输出文件`));
      }, timeoutMs);

      child.on('error', (error) => settle(error));
      child.on('exit', () => {
        const text = readOut();
        if (text) done(text);
        else settle(new Error('codex exec 已退出，但没有产生 -o 输出文件'));
      });

      // 控制指令（打断）可以中止本轮
      if (ctx.signal) {
        const onAbort = () => settle(new Error('aborted: 已按控制指令中断本轮生成'));
        if (ctx.signal.aborted) onAbort();
        else ctx.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  },
};
