#!/usr/bin/env node
// 给员工分配 / 重新分配头像。
//
// 头像库有两种形态，脚本都认：
//   composed —— face/base-face-reference.png + hair/hair-XX.png（固定脸型 + 随机发型）
//   flat     —— 目录里直接放一堆完整头像
//
// 用法：
//   node tools/assign-avatars.mjs            # 只给还没头像的人分配
//   node tools/assign-avatars.mjs --force    # 全部重新随机（换一批脸）
//   node tools/assign-avatars.mjs --board http://127.0.0.1:8787

const BOARD = (() => {
  const index = process.argv.indexOf('--board');
  return (index !== -1 ? process.argv[index + 1] : process.env.MB_BOARD) || 'http://127.0.0.1:8787';
})().replace(/\/+$/, '');
const FORCE = process.argv.includes('--force');

const post = async (path, body) => {
  const response = await fetch(`${BOARD}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.ok === false) throw new Error(json.error || `HTTP ${response.status}`);
  return json;
};

const state = await fetch(`${BOARD}/api/state`).then((r) => r.json());
if (!state.ok) throw new Error('黑板没响应，先启动服务：npm start');

const library = state.avatar || {};
console.log(`头像库：${library.dir || '(没找到)'}`);
console.log(`  形态：${library.kind}，发型 ${library.hairs} 个，现成头像 ${library.files} 个`);
if (library.kind === 'none') {
  console.log('库里还没有可用素材，先放图再跑这个脚本。');
  process.exit(0);
}

let assigned = 0;
let skipped = 0;
for (const employee of state.employees) {
  const hasAvatar = Boolean(employee.avatar?.hair || employee.avatar?.file);
  if (hasAvatar && !FORCE) {
    skipped += 1;
    continue;
  }
  // 只传身份字段：apiKey 不传，服务端会沿用原有的（不会把单独配的 key 抹掉）
  await post('/api/employee', {
    id: employee.id,
    name: employee.name,
    title: employee.title,
    level: employee.level,
    departmentId: employee.departmentId,
    managerId: employee.managerId,
    description: employee.description,
    model: employee.model,
    baseUrl: employee.baseUrl,
    // 强制重挑时先把旧头像清掉
    ...(FORCE ? { avatar: null } : {}),
  });
  assigned += 1;
}

const after = await fetch(`${BOARD}/api/state`).then((r) => r.json());
console.log('');
console.log(`本次分配 ${assigned} 人，跳过已有头像 ${skipped} 人`);
console.log('分配结果：');
for (const employee of after.employees) {
  const mark = employee.avatar?.hair || employee.avatar?.file || '(无色块兜底)';
  console.log(`  ${employee.name.padEnd(4, '　')} ${mark}`);
}
