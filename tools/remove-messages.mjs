#!/usr/bin/env node
// 蜂群 HIVE · 清理测试留言
//
// 用途：把脚本/测试插进面板的留言连同"由它触发的回复链"一起删掉，真实对话不受影响。
// 判定方式：以某条留言为起点，保留其 id 到它的 replyTo 链；凡是指向它（或它的后代）的回复都算测试产物。
//
// 用法：
//   node tools/remove-messages.mjs --list                       # 列出疑似测试留言
//   node tools/remove-messages.mjs --id m_xxxxxxxx --apply      # 删掉这条及其回复链（先备份）

import fs from 'node:fs';
import path from 'node:path';

const DATA = process.env.HIVE_DATA_DIR || path.resolve(process.cwd(), 'data');
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const listOnly = args.includes('--list') || !apply;
const ids = args.filter((a, i) => args[i - 1] === '--id');

const SUSPECT = [/^@.*分派一下/, /^@.*让前端、后端/, /^你们前端现在这个页面/, /^用一句话说清楚/, /^只回复两个字/];

const threadsDir = path.join(DATA, 'threads');
const files = [];
for (const mode of ['department', 'project', 'employee']) {
  const dir = path.join(threadsDir, mode);
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    files.push(path.join(dir, name));
  }
}

let total = 0;
for (const file of files) {
  const messages = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const suspects = messages.filter((m) => SUSPECT.some((p) => p.test(String(m.text || ''))) || ids.includes(m.id));
  if (!suspects.length) continue;

  // 把"由这些留言触发的回复链"一起标出来
  const doomed = new Set(suspects.map((m) => m.id));
  let grew = true;
  while (grew) {
    grew = false;
    for (const m of messages) {
      if (doomed.has(m.id)) continue;
      if (m.replyTo && doomed.has(m.replyTo)) { doomed.add(m.id); grew = true; }
    }
  }

  console.log(`\n${file.replace(threadsDir, 'threads')}`);
  for (const m of suspects) {
    console.log(`  起点 ${m.id}  ${new Date(m.at).toLocaleString('zh-CN')}  ${m.fromName}：${String(m.text).slice(0, 40)}`);
  }
  console.log(`  连带回复：${doomed.size - suspects.length} 条；合计要删 ${doomed.size} 条 / 共 ${messages.length} 条`);
  if (apply) {
    const backup = `${file}.${Date.now()}.bak`;
    fs.writeFileSync(backup, fs.readFileSync(file));
    fs.writeFileSync(file, messages.filter((m) => !doomed.has(m.id)).map((m) => JSON.stringify(m)).join('\n') + '\n');
    console.log(`  已删除，原文件备份：${path.basename(backup)}`);
  }
  total += doomed.size;
}

if (!total) console.log('没找到需要清理的测试留言。');
else if (listOnly) console.log('\n（预览模式，没有改动。加 --apply 才真正删除）');