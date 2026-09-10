// 探针：在被 autostart 那样"间接拉起"的 node 里，测试各种 spawn 变体是否能成功。
// 目的：区分是"沙箱禁止管道 stdio"还是"沙箱禁止创建进程"。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const out = process.argv[2] || path.join(process.cwd(), 'data', 'logs', 'spawn-probe.txt');
const lines = [];
const log = (text) => {
  lines.push(text);
  console.log(text);
};

const codexExe = path.join(
  process.env.APPDATA || '',
  'npm',
  'node_modules',
  '@openai',
  'codex',
  'node_modules',
  '@openai',
  'codex-win32-x64',
  'vendor',
  'x86_64-pc-windows-msvc',
  'bin',
  'codex.exe',
);

function attempt(label, file, args, options) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, options);
    } catch (error) {
      log(`${label}: THROW ${error.code || ''} ${error.message}`);
      resolve();
      return;
    }
    let settled = false;
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      log(`${label}: ERROR ${error.code || ''} ${error.message}`);
      resolve();
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      log(`${label}: exit=${code}`);
      resolve();
    });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
      log(`${label}: TIMEOUT`);
      resolve();
    }, 8000);
  });
}

const timeout = (ms) => new Promise((r) => setTimeout(r, ms));

await attempt('A node --version (ignore)', process.execPath, ['--version'], { stdio: 'ignore', windowsHide: true });
await attempt('B node --version (pipe)', process.execPath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
await attempt('C cmd /c echo (ignore)', 'C:\\Windows\\System32\\cmd.exe', ['/c', 'echo', 'hi'], { stdio: 'ignore', windowsHide: true });
await attempt('D cmd /c echo (pipe)', 'C:\\Windows\\System32\\cmd.exe', ['/c', 'echo', 'hi'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
await attempt('E codex.exe --version (ignore)', codexExe, ['--version'], { stdio: 'ignore', windowsHide: true });
await attempt('F codex.exe app-server (pipe)', codexExe, ['app-server', '--listen', 'stdio://'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
await timeout(1500);

// 环境线索
log(`env.ComSpec=${process.env.ComSpec || '(空)'}`);
log(`env.SystemRoot=${process.env.SystemRoot || '(空)'}`);
log(`cwd=${process.cwd()} exists=${fs.existsSync(process.cwd())}`);
log(`node=${process.execPath}`);
log(`codex exe exists=${fs.existsSync(codexExe)}`);

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, lines.join('\n') + '\n', 'utf8');
process.exit(0);
