#!/usr/bin/env node
// 蜂群 HIVE · 职级批量设定
//
// 把全体员工的职级按团队结构刷一遍：经理（P3）→ 项目负责人（P2）→ 普通员工（P1），
// 并清掉员工自己填的模型，让模型完全由职级决定（见 store.js 的 levelChannels）。
//
// 判定规则（标题里带"负责人"的算项目负责人；没有上级的那个算经理）：
//   · 处长/经理：managerId 为空的那位，或标题里带「经理 / 总监 / 主管」
//   · 项目负责人：标题里带「负责人 / 组长 / lead」
//   · 其余：普通员工
//
// 用法：
//   node tools/assign-levels.mjs              # 只看会怎么改（dry-run）
//   node tools/assign-levels.mjs --apply      # 真的写回

const BASE = process.env.HIVE_BASE || 'http://127.0.0.1:8787';
const APPLY = process.argv.includes('--apply');

const RANK = { manager: 'P3', lead: 'P2', worker: 'P1' };
const LABEL = { manager: '经理', lead: '项目负责人', worker: '普通员工' };

const state = await (await fetch(`${BASE}/api/state`)).json();
const employees = state.employees;
if (!employees.length) {
  console.log('没有员工，先建人。');
  process.exit(0);
}

function levelOf(employee) {
  const title = String(employee.title || '');
  if (/经理|总监|主管/.test(title)) return 'manager';
  if (/负责人|组长|lead/i.test(title)) return 'lead';
  if (!employee.managerId) return 'manager';   // 没有上级 = 顶层
  return 'worker';
}

const plan = employees.map((employee) => ({
  id: employee.id,
  name: employee.name,
  title: employee.title,
  from: employee.level || 'worker',
  to: levelOf(employee),
  hadOwnModel: Boolean(String(employee.model || '').trim()),
}));

console.log(`${APPLY ? '写入' : '预览'}：${plan.length} 位员工\n`);
console.log('  名字   职能              现在     →  职级      模型（由职级决定）');
for (const item of plan) {
  const channel = state.settings.levelChannels?.[item.to] || {};
  const models = Array.isArray(channel.models) && channel.models.length ? channel.models.join('/') : `全局默认（${state.settings.model}）`;
  const changed = item.from !== item.to ? ' *' : '  ';
  console.log(`  ${item.name.padEnd(5)} ${String(item.title).padEnd(16)} ${item.from.padEnd(8)}→ ${RANK[item.to]} ${LABEL[item.to]}`.padEnd(60) + `${changed}${models}${item.hadOwnModel ? '（清掉他自己填的模型）' : ''}`);
}

if (!APPLY) {
  console.log('\n（dry-run，没写盘。加 --apply 才真正写回）');
  process.exit(0);
}

let done = 0;
for (const item of plan) {
  const res = await fetch(`${BASE}/api/employee`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: item.id, level: item.to, model: '' }),   // 其余字段服务端沿用原值
  });
  if (res.ok) done++;
  else console.log(`  ${item.name} 写入失败：${res.status} ${(await res.text()).slice(0, 120)}`);
}
console.log(`\n已写入 ${done}/${plan.length} 位`);

const after = await (await fetch(`${BASE}/api/state`)).json();
console.log('\n复核（服务端算出来的实际通道）：');
for (const employee of after.employees) {
  const channel = employee.channel || {};
  console.log(`  ${employee.name.padEnd(5)} ${String(channel.rank).padEnd(3)} ${LABEL[channel.level] || channel.level}  模型=${channel.model}`);
}
