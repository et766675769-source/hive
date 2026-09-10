// 打印 ClientRequest.oneOf 里 thread/turn 相关条目的完整结构（含 params）
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || 'C:/Users/ET/AppData/Local/Temp/codex-schema';
const wanted = new Set(['thread/start', 'thread/resume', 'turn/start', 'turn/steer', 'turn/interrupt']);

const file = path.join(dir, 'codex_app_server_protocol.v2.schemas.json');
const json = JSON.parse(fs.readFileSync(file, 'utf8'));
const defs = json.definitions || json.$defs || {};
const req = (defs.ClientRequest || json.ClientRequest || {}).oneOf || [];

console.log('ClientRequest 变体数量：' + req.length);

for (const [index, variant] of req.entries()) {
  const method = variant?.properties?.method?.enum?.[0] || variant?.properties?.method?.const;
  if (!wanted.has(method)) continue;
  console.log(`\n########## [${index}] ${method} ##########`);
  console.log('required: ' + JSON.stringify(variant.required));
  console.log(JSON.stringify(variant.properties?.params ?? variant.properties, null, 1).slice(0, 3000));
}

// 顺带找 thread/start 与 turn/start 的响应
const res = (defs.ServerNotification || json.ServerNotification || {}).oneOf || [];
const notifNames = res
  .map((v) => v?.properties?.method?.enum?.[0] || v?.properties?.method?.const)
  .filter(Boolean);
console.log('\n服务端通知方法（前 40）：\n' + notifNames.slice(0, 40).join('\n'));
