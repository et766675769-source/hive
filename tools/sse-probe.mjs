// SSE 实时通道体检：连上黑板的 /api/stream，统计 12 秒内各类事件，
// 并同时单独打一次 /api/state，比较两边看到的"最新序号"是否一致。
// 用法：node tools/sse-probe.mjs [baseUrl] [seconds]
const base = process.argv[2] || 'http://127.0.0.1:8787';
const seconds = Number(process.argv[3] || 12);

const counts = new Map();
let firstEventAt = null;
let bytes = 0;

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), seconds * 1000);

try {
  const response = await fetch(`${base}/api/stream`, { signal: controller.signal });
  console.log(`SSE 连接：HTTP ${response.status}  content-type=${response.headers.get('content-type')}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const started = Date.now();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.length;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const event = /^event:\s*(.+)$/m.exec(chunk);
      const name = event ? event[1].trim() : '(无 event 名)';
      if (firstEventAt === null) firstEventAt = Date.now() - started;
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
} catch (error) {
  if (error.name !== 'AbortError') console.log(`SSE 出错：${error.message}`);
} finally {
  clearTimeout(timer);
}

console.log(`\n在 ${seconds} 秒内收到 ${bytes} 字节`);
console.log(`首个事件延迟：${firstEventAt === null ? '未收到任何事件' : `${firstEventAt}ms`}`);
console.log('事件分布：');
for (const [name, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${name} × ${count}`);
}

try {
  const state = await (await fetch(`${base}/api/state?limit=1`)).json();
  console.log(`\n对照 /api/state：最新序号 #${state.stats.latestSeq}，留言 ${state.stats.total} 条，成员 ${state.agents.length} 个`);
} catch (error) {
  console.log(`\n/api/state 读取失败：${error.message}`);
}
