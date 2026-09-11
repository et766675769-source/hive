// 用无头 Chrome 真正渲染一次面板，检查"契约状态"是否出现在成员行上。
// 只做 DOM 断言：我看不了截图，就断言渲染出来的文本与属性。
const targets = process.argv.slice(2);
if (!targets.length) {
  console.error('用法：node tools/panel-dom-check.mjs <检查脚本路径>');
  process.exit(2);
}

const port = 9333 + Math.floor(Math.random() * 200);
const { spawn } = await import('node:child_process');
const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');
const { pathToFileURL } = await import('node:url');

const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const chrome = chromeCandidates.find((candidate) => fs.existsSync(candidate));
if (!chrome) {
  console.error('找不到 Chrome/Edge；设 CHROME_PATH 再试。');
  process.exit(2);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-dom-'));
const child = spawn(
  chrome,
  ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', 'about:blank'],
  { stdio: 'ignore', windowsHide: true },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function debuggerUrl() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error('Chrome 调试端口没有就绪');
}

const ws = new WebSocket(await debuggerUrl());
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});
await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
  return result.result?.result?.value;
};

try {
  const spec = await import(pathToFileURL(path.resolve(targets[0])).href);
  const outcome = await spec.run({ send, evaluate, sleep });
  console.log(JSON.stringify(outcome, null, 2));
  if (!outcome.ok) process.exitCode = 1;
} finally {
  try {
    ws.close();
  } catch {
    /* 忽略 */
  }
  child.kill();
  await sleep(300);
  fs.rmSync(profile, { recursive: true, force: true });
}
