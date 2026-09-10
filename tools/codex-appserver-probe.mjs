// Codex app-server 探针：跑通 initialize → thread/start → turn/start，并打印全部收发
// 用法：node tools/codex-appserver-probe.mjs ["要发给 Codex 的话"]
import { spawn } from 'node:child_process';

const prompt = process.argv[2] || '只回答四个字：通道已通。不要读任何文件。';

const child = spawn('codex', ['app-server', '--listen', 'stdio://'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: true,
  windowsHide: true,
});

let seq = 0;
const pending = new Map();

function send(message) {
  const line = JSON.stringify(message);
  console.log('→ ' + line.slice(0, 400));
  child.stdin.write(line + '\n');
}

function request(method, params) {
  const id = ++seq;
  pending.set(id, method);
  send({ id, method, params });
  return id;
}

let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      console.log('← (非 JSON) ' + line.slice(0, 300));
      continue;
    }
    const kind = message.id ? `响应#${message.id}(${pending.get(message.id) || '?'})` : `通知 ${message.method || ''}`;
    const body = message.error
      ? 'ERROR ' + JSON.stringify(message.error)
      : JSON.stringify(message.result ?? message.params ?? message).slice(0, 700);
    console.log(`← ${kind}: ${body}`);

    if (message.id === 1 && message.result) {
      send({ method: 'initialized' });
      request('thread/start', {});
    }
    if (message.id === 2) {
      const threadId = message.result?.thread?.id || message.result?.threadId || message.result?.id;
      console.log('\n*** thread id = ' + threadId + ' ***\n');
      if (threadId) {
        request('turn/start', { threadId, input: [{ type: 'text', text: prompt }] });
      }
    }
    if (message.method === 'turn/completed') {
      console.log('\n*** 回合完成，10 秒后退出 ***\n');
      setTimeout(() => {
        child.kill();
        process.exit(0);
      }, 10000);
    }
  }
});

child.stderr.on('data', (chunk) => {
  const text = chunk.toString('utf8').trim();
  if (text) console.log('stderr: ' + text.slice(0, 400));
});

child.on('exit', (code) => console.log(`app-server 退出：${code}`));

setTimeout(() => request('initialize', { clientInfo: { name: 'message-board', title: 'Message Board', version: '0.1.0' } }), 1500);
setTimeout(() => {
  console.log('\n[探针超时，退出]');
  child.kill();
  process.exit(1);
}, 180000);
