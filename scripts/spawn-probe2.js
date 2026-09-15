/* 定位 EPERM 根因：shim 是否加载？何种 spawn 方式可行？ */
'use strict';
const cp = require('child_process');
const path = require('path');

console.log('NODE_OPTIONS =', JSON.stringify(process.env.NODE_OPTIONS ?? null));
console.log('execArgv     =', JSON.stringify(process.execArgv));
console.log(
  'spawnSync 已被改写 =',
  !/\[native code\]/.test(cp.spawnSync.toString()) && cp.spawnSync.toString().length > 400,
);
console.log('spawnSync 源码前 120 字:', cp.spawnSync.toString().slice(0, 120).replace(/\s+/g, ' '));

const sysRoot = process.env.SystemRoot || 'C:\\Windows';
const ps = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const cleanEnv = { SystemRoot: sysRoot, windir: sysRoot, PATH: `${sysRoot}\\System32;${sysRoot}` };

const variants = [
  ['默认 env', { windowsHide: true, timeout: 20000 }],
  ['净化 env', { windowsHide: true, timeout: 20000, env: cleanEnv }],
  ['shell:true', { windowsHide: true, timeout: 20000, shell: true, env: cleanEnv }],
  ['cmd.exe 包裹', { windowsHide: true, timeout: 20000, env: cleanEnv }],
];

for (const [label, opts] of variants) {
  try {
    const argv = label === 'cmd.exe 包裹' ? [] : ['-NoProfile', '-Command', 'echo hi'];
    const exe = label === 'cmd.exe 包裹' ? path.join(sysRoot, 'System32', 'cmd.exe') : ps;
    const a = label === 'cmd.exe 包裹' ? ['/c', ps, '-NoProfile', '-Command', 'echo hi'] : argv;
    const r = cp.spawnSync(exe, a, { encoding: 'utf8', ...opts });
    console.log(
      `  ${label.padEnd(14)} ${r.error ? `ERR ${r.error.code}` : `OK status=${r.status}`}  out=${JSON.stringify(String(r.stdout || '').trim().slice(0, 30))}`,
    );
  } catch (e) {
    console.log(`  ${label.padEnd(14)} THROW ${e.message}`);
  }
}

// execFile / exec 也试一下
try {
  cp.execFileSync(ps, ['-NoProfile', '-Command', 'echo via-execFile'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
    env: cleanEnv,
  });
  console.log('  execFileSync    OK');
} catch (e) {
  console.log(`  execFileSync    ERR ${e.code}`);
}
