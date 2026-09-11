// 复现：桩黑板 + 照抄 serve 的"笨成员"，把时间线打出来（脱离测试框架）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBoardServer } from '../server/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-board-'));
const { server, presence } = createBoardServer({ dataDir, quiet: true });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
console.log('桩黑板', base);

const post = async (apiPath, body) =>
  (await fetch(`${base}${apiPath}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();

await post('/api/message', { agent: 'local', kind: 'message', text: '@rookie 请确认你能实时收到点名并回话。' });
console.log('已点名');

const child = spawn(process.execPath, ['tools/mb.js', 'serve', 'rookie', '--name', '新人', '--board', base], {
  cwd: repoRoot,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => {
  output += chunk.toString('utf8');
});
child.stderr.on('data', (chunk) => {
  output += chunk.toString('utf8');
});
child.on('error', (error) => console.log('SPAWN ERROR', error.message));

const started = Date.now();
for (let i = 0; i < 12; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const state = await (await fetch(`${base}/api/state?limit=5`)).json();
  const rookie = state.agents.find((agent) => agent.id === 'rookie');
  console.log(
    `${((Date.now() - started) / 1000).toFixed(0)}s | 成员=${rookie ? rookie.state : '无'} 契约=${rookie?.contract?.state || '-'} | 留言=${state.messages.length} | 子进程输出 ${output.length} 字`,
  );
  if (/已回复/.test(output)) break;
}
console.log('--- 子进程输出 ---');
console.log(output);
const state = await (await fetch(`${base}/api/state?limit=8`)).json();
for (const message of state.messages) {
  console.log(`#${message.seq} [${message.agentName}] ${message.kind} replyTo=${message.replyTo || '-'} :: ${String(message.text).replace(/\s+/g, ' ').slice(0, 80)}`);
}
child.kill();
presence.stop();
await new Promise((resolve) => server.close(resolve));
