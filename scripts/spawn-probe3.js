/* 验证：经 cmd.exe 转发 + -EncodedCommand 调用 PowerShell 是否可行 */
'use strict';
const cp = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sysRoot = process.env.SystemRoot || 'C:\\Windows';
const ps = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const cmd = path.join(sysRoot, 'System32', 'cmd.exe');

const script = [
  "$ErrorActionPreference='Stop'",
  'Add-Type -AssemblyName System.Speech',
  '$s=New-Object System.Speech.Synthesis.SpeechSynthesizer',
  'foreach ($v in $s.GetInstalledVoices()) { if ($v.Enabled) { [Console]::Out.WriteLine($v.VoiceInfo.Name + "|" + $v.VoiceInfo.Culture.Name) } }',
  '$s.Dispose()',
].join('\n');
const b64 = Buffer.from(script, 'utf16le').toString('base64');

console.log('--- A. 直接 execFileSync（预期 EPERM）---');
try {
  const out = cp.execFileSync(ps, ['-NoProfile', '-EncodedCommand', b64], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  console.log('OK:\n' + out);
} catch (e) {
  console.log('ERR', e.code);
}

console.log('\n--- B. 经 cmd.exe 转发 ---');
try {
  const out = cp.execFileSync(
    cmd,
    ['/d', '/s', '/c', ps, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 },
  );
  console.log('OK:\n' + out.trim());
} catch (e) {
  console.log('ERR', e.code, String(e.stderr || '').slice(0, 300));
}

console.log('\n--- C. shell:true ---');
try {
  const out = cp.execFileSync(`${ps} -NoProfile -EncodedCommand ${b64}`, {
    shell: true,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
  console.log('OK:\n' + out.trim());
} catch (e) {
  console.log('ERR', e.code, String(e.stderr || '').slice(0, 200));
}

console.log('\n--- D. 经 cmd.exe 实际合成中文 WAV ---');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ttsprobe-'));
const outWav = path.join(tmp, 'out.wav');
const text = '2009年06月六级听力真题';
const textB64 = Buffer.from(text, 'utf8').toString('base64');
const synth = [
  "$ErrorActionPreference='Stop'",
  'Add-Type -AssemblyName System.Speech',
  `$text=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${textB64}'))`,
  '$s=New-Object System.Speech.Synthesis.SpeechSynthesizer',
  '$fmt=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(22050,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono)',
  `$s.SetOutputToWaveFile('${outWav.replace(/\\/g, '\\\\')}', $fmt)`,
  'try { $s.Speak($text) } finally { $s.Dispose() }',
  "[Console]::Out.WriteLine('DONE')",
].join('\n');
const synthB64 = Buffer.from(synth, 'utf16le').toString('base64');
try {
  const out = cp.execFileSync(
    cmd,
    ['/d', '/s', '/c', ps, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', synthB64],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 },
  );
  console.log('  cmd 输出:', JSON.stringify(out.trim()));
} catch (e) {
  console.log('  ERR', e.code, String(e.stderr || '').slice(0, 300));
}
if (fs.existsSync(outWav)) {
  const b = fs.readFileSync(outWav);
  const af = b.readUInt16LE(20);
  const ch = b.readUInt16LE(22);
  const sr = b.readUInt32LE(24);
  const bits = b.readUInt16LE(34);
  console.log(`  生成成功 ${b.length} B  fmt=${af} ${ch}ch ${sr}Hz ${bits}bit  头部=${b.indexOf(Buffer.from('data')) + 8}`);
} else {
  console.log('  未生成文件');
}
