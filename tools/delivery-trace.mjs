// 看某条投递的状态变迁（排障用）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'data', 'deliveries.jsonl');
const needle = process.argv[2] || '000165';
const agent = process.argv[3] || 'workbuddy';

const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
const hits = lines.filter((line) => line.includes(needle) && line.includes(`"${agent}"`));
console.log(`匹配 ${hits.length} 条：${needle} / ${agent}`);
for (const line of hits.slice(-10)) {
  const record = JSON.parse(line);
  const at = record.at ? new Date(record.at).toLocaleTimeString() : '?';
  console.log(`${at}  ${String(record.state || '').padEnd(10)} endedBy=${record.endedBy || '-'} attempts=${record.attempts} renewals=${record.renewals ?? '-'} note=${String(record.note || '').slice(0, 46)}`);
}
