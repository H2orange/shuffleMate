/* 探测 cscript.exe + VBScript + SAPI COM 这条后备语音后端是否可用 */
'use strict';
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sysRoot = process.env.SystemRoot || 'C:\\Windows';
const cscript = path.join(sysRoot, 'System32', 'cscript.exe');
console.log('cscript 存在:', fs.existsSync(cscript));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vbsprobe-'));
const textFile = path.join(tmp, 't.txt');
const outFile = path.join(tmp, 'o.wav');
const vbsFile = path.join(tmp, 't.vbs');

// 文本以 UTF-16LE + BOM 写入，VBScript 用 ADODB.Stream 以 unicode 读回
fs.writeFileSync(textFile, '\ufeff' + '2009年06月六级听力真题', 'utf16le');

const VBS = [
  'Option Explicit',
  'Dim a, tf, of, st, txt, v, fs, all, i, chosen',
  'Set a = WScript.Arguments',
  'tf = a(0)',
  'of = a(1)',
  'Set st = CreateObject("ADODB.Stream")',
  'st.CharSet = "unicode"',
  'st.Open',
  'st.LoadFromFile tf',
  'txt = st.ReadText(-1)',
  'st.Close',
  'Set v = CreateObject("SAPI.SpVoice")',
  'Set all = v.GetVoices',
  'chosen = all.Item(0).GetDescription',
  'For i = 0 To all.Count - 1',
  '  If InStr(LCase(all.Item(i).GetDescription), "huihui") > 0 Then chosen = all.Item(i).GetDescription',
  'Next',
  'For i = 0 To all.Count - 1',
  '  If all.Item(i).GetDescription = chosen Then v.Voice = all.Item(i)',
  'Next',
  'Set fs = CreateObject("SAPI.SpFileStream")',
  'fs.Format.Type = 22',
  'fs.Open of, 3, False',
  'v.AudioOutputStream = fs',
  'v.Speak txt',
  'fs.Close',
  'WScript.Echo "OK " & chosen',
].join('\r\n');
fs.writeFileSync(vbsFile, VBS, 'latin1');

console.log('\n--- cscript 直接运行 VBS ---');
try {
  const r = cp.spawnSync(cscript, ['//Nologo', vbsFile, textFile, outFile], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
  console.log('  status =', r.status, ' error =', r.error && r.error.code);
  console.log('  stdout =', JSON.stringify(String(r.stdout || '').trim()));
  console.log('  stderr =', JSON.stringify(String(r.stderr || '').trim().slice(0, 200)));
} catch (e) {
  console.log('  EXC', e.message);
}

if (fs.existsSync(outFile)) {
  const b = fs.readFileSync(outFile);
  const af = b.readUInt16LE(20);
  const ch = b.readUInt16LE(22);
  const sr = b.readUInt32LE(24);
  const bits = b.readUInt16LE(34);
  console.log(`\n  生成成功: ${b.length} B  fmt=${af} ${ch}ch ${sr}Hz ${bits}bit  data@${b.indexOf(Buffer.from('data')) + 8}`);
  console.log('  输出路径:', outFile);
} else {
  console.log('\n  未生成文件');
}
