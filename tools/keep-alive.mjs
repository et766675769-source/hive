#!/usr/bin/env node
// 给"人工唤起型"成员挂一个诚实的在场心跳。
//
// 用途：像 DSH 这种不常驻的成员（由人类在会话里唤起才动），面板上若完全不心跳就会显示掉线。
// 这个脚本只上报"我在场"，并在备注里写明**需要人工唤起**，不假装会自动响应点名。
//
//   node tools/keep-alive.mjs --agent dsh --note "会话在线；需人工唤起"
//
// 它不做长轮询、不接点名——那是常驻通道的事。声明 manual 的成员本就该这样表现。

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const inline = args.find((item) => item.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : fallback;
};

const BOARD = (flag('board') || process.env.MB_BOARD || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const AGENT = String(flag('agent') || '').trim().toLowerCase();
const NOTE = flag('note', '会话在线；需人工唤起（点名不会自动响应）');
const INTERVAL = Math.max(5, Number(flag('interval', 20)));

if (!AGENT) {
  console.error('用法：node tools/keep-alive.mjs --agent <id> [--note 备注] [--interval 20]');
  process.exit(2);
}

const log = (...parts) => console.log(`[keep-alive ${AGENT} ${new Date().toLocaleTimeString()}]`, ...parts);

for (;;) {
  try {
    const response = await fetch(`${BOARD}/api/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: AGENT, state: 'online', note: NOTE, source: 'keep-alive' }),
    });
    if (!response.ok) log(`心跳失败：HTTP ${response.status}`);
  } catch (error) {
    log(`心跳失败：${error.message}`);
  }
  await new Promise((resolve) => setTimeout(resolve, INTERVAL * 1000));
}
