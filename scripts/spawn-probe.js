/* 探测 Node 能否派生子进程（用于定位语音合成 EPERM 的根因） */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const sysRoot = process.env.SystemRoot || 'C:\\Windows';
const ps = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const tests = [
  ['cmd.exe', path.join(sysRoot, 'System32', 'cmd.exe'), ['/c', 'echo hi']],
  ['where.exe', path.join(sysRoot, 'System32', 'where.exe'), ['cmd']],
  ['powershell.exe', ps, ['-NoProfile', '-Command', 'echo hi']],
  ['node(self)', process.execPath, ['-e', 'console.log(1)']],
];

for (const [label, p, args] of tests) {
  try {
    const r = spawnSync(p, args, { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    const out = String(r.stdout || '').trim().slice(0, 50);
    const err = String(r.stderr || '').trim().slice(0, 80);
    console.log(
      `${r.error ? `ERR(${r.error.code})` : 'OK        '}  ${label.padEnd(16)} status=${r.status}  out=${JSON.stringify(out)}${err ? ` err=${JSON.stringify(err)}` : ''}`,
    );
  } catch (e) {
    console.log(`THROW     ${label}  ${e.message}`);
  }
}
