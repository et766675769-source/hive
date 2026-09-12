#!/usr/bin/env node
// 用 MCP 协议在真实黑板上跑完一轮"取件 → 回执 → 交付"。
//
// 用途：
//   1) 验收某个成员的 MCP 通道是否真的通（取代人工点一遍）；
//   2) 当参考实现——宿主（WorkBuddy / Claude / Cursor…）只要能让 agent 循环调用这几个工具，
//      就能成为一个会回话的黑板成员。
//
// 用法：
//   node tools/mcp-round.mjs --agent workbuddy --name WorkBuddy [--board http://127.0.0.1:8787]
//   node tools/mcp-round.mjs --agent workbuddy --wait-only      # 只挂机等点名并自动回执+交付

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const inline = args.find((item) => item.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : fallback;
};

const AGENT = String(flag('agent') || 'workbuddy').toLowerCase();
const NAME = flag('name', AGENT);
const BOARD = (flag('board') || process.env.MB_BOARD || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const WAIT_ONLY = args.includes('--wait-only');

const child = spawn(process.execPath, [path.join(ROOT, 'mcp', 'server.mjs'), '--agent', AGENT, '--name', NAME, '--board', BOARD], {
  cwd: ROOT,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = '';
const waiters = new Map();
let seq = 0;
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index = buffer.indexOf('\n');
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      try {
        const message = JSON.parse(line);
        if (message.id && waiters.has(message.id)) {
          waiters.get(message.id)(message);
          waiters.delete(message.id);
        }
      } catch {
        /* 忽略 */
      }
    }
    index = buffer.indexOf('\n');
  }
});
child.stderr.on('data', (chunk) => process.stderr.write(chunk));

const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    waiters.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => {
      if (waiters.has(id)) {
        waiters.delete(id);
        reject(new Error(`MCP 调用超时：${method}`));
      }
    }, 120000);
  });

const callTool = async (name, toolArgs = {}) => {
  const result = await rpc('tools/call', { name, arguments: toolArgs });
  const text = result.result?.content?.[0]?.text || '';
  if (result.result?.isError) throw new Error(text);
  return text;
};

const log = (...parts) => console.log(`[mcp-round ${AGENT} ${new Date().toLocaleTimeString()}]`, ...parts);

async function main() {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcp-round' } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  log(`已连接黑板 ${BOARD}；身份 ${AGENT}`);
  log(await callTool('board_join', { name: NAME, engine: 'mcp' }));

  if (WAIT_ONLY) {
    for (;;) {
      const envelope = await callTool('board_wait', { wait_seconds: 25 });
      if (!/messageId:/.test(envelope)) continue;
      const replyTo = (/messageId: (\S+)/.exec(envelope) || [])[1];
      log(`收到点名 ${replyTo}`);
      await callTool('board_ack', { reply_to: replyTo, note: 'MCP 通道已接单' });
      await callTool('board_reply', {
        reply_to: replyTo,
        text: `结论：${AGENT} 的 MCP 通道可用，已按契约先回执、后交付。\n依据：${new Date().toLocaleString()} 通过 stdio MCP 工具完成一轮。\n下一步：宿主保持 board_wait 循环即可实时响应。`,
      });
    }
  }

  // 单轮验收：等一条点名 → 回执 → 交付
  log('等待一条点名（最多 30 秒）…');
  const envelope = await callTool('board_wait', { wait_seconds: 30 });
  if (!/messageId:/.test(envelope)) {
    log(`这一轮没有点名：${envelope}`);
    log('要验收完整一轮，请另开终端发一条点名，例如：');
    log(`  curl -X POST ${BOARD}/api/message -H "Content-Type: application/json" -d "{\\"agent\\":\\"local\\",\\"text\\":\\"@${AGENT} 请确认 MCP 通道可用\\"}"`);
    return;
  }
  const replyTo = (/messageId: (\S+)/.exec(envelope) || [])[1];
  log(`收到点名 ${replyTo}`);
  const tAck = Date.now();
  log(await callTool('board_ack', { reply_to: replyTo, note: 'MCP 通道已接单' }));
  log(`回执耗时 ${Date.now() - tAck}ms`);
  log(await callTool('board_reply', {
    reply_to: replyTo,
    text: `结论：${AGENT} 的 MCP 通道可用，已按契约先回执、后交付。\n依据：${new Date().toLocaleString()} 通过 stdio MCP 工具完成一轮。\n下一步：宿主保持 board_wait 循环即可实时响应。`,
  }));
  log('一轮完成 ✅');
}

main()
  .catch((error) => {
    console.error(`MCP 轮次失败：${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    if (!WAIT_ONLY) child.kill();
  });
