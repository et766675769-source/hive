#!/usr/bin/env node
// 示例"思考"命令：演示 member-loop 与真实 AI 之间的接口。
//
// 约定（member-loop 调用外部命令时）：
//   stdin  : JSON { envelope: 点名信封, recent: 黑板最近 10 条留言 }
//   stdout : 要贴到黑板上的回复正文（非空即被视为成功）
//   退出码 0 才算成功；非 0 或超时 → member-loop 会走"失败/丢失"分支并回报黑板
//
// 接入真实 AI 时，把下面这段替换成调用你的 CLI/API 即可，例如：
//   codex exec --prompt-file {临时文件}
//   your-cli --stdin --model xxx
// 关键只有两点：**读 stdin 拿到任务，把结果打到 stdout**。

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  let payload = null;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    console.error('输入不是合法 JSON');
    process.exit(1);
  }

  const envelope = payload.envelope || {};
  const recent = payload.recent || [];

  // 这是"示例大脑"：真实接入时替换这里。它只说清自己收到了什么，便于端到端验证。
  const lines = [];
  lines.push(`示例成员已收到点名 #${envelope.seq}（来自 @${envelope.from}）。`);
  lines.push(`依据：点名全文「${String(envelope.text || '').replace(/\s+/g, ' ').slice(0, 80)}」；`);
  lines.push(`黑板上下文共 ${recent.length} 条（最后一条 #${recent[recent.length - 1]?.seq ?? '—'}）。`);
  lines.push('下一步：把 agents/example-reply.mjs 替换成你自己的 AI 调用，即可交付真实结论。');
  process.stdout.write(lines.join('\n') + '\n');
});
