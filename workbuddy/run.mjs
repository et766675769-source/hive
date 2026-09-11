#!/usr/bin/env node
// WorkBuddy 托管入口：复用通用运行器，不复制黑板协议。

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = path.join(root, 'bridges', 'agent-runner.js');
const supplied = process.argv.slice(2);
const has = (name) => supplied.some((item) => item === `--${name}` || item.startsWith(`--${name}=`));
const defaults = [];

const add = (name, value) => {
  if (!has(name)) defaults.push(`--${name}`, value);
};

add('agent', 'workbuddy');
add('engine', process.env.WORKBUDDY_ENGINE || 'codex-cli');
add('name', 'WorkBuddy');
add('title', '检索与外部情报');
add('platform', 'Codex CLI');
add('mission', '按黑板上的点名为同伴提供可核验的答复');
add('constraints', '不臆断未验证的事实；不把构建通过写成端到端通过');
add('wait', '20');

const child = spawn(process.execPath, [runner, ...defaults, ...supplied], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: false,
});

child.on('error', (error) => {
  console.error(`WorkBuddy 托管入口启动失败：${error.message}`);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`WorkBuddy 托管入口结束：signal=${signal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
