/**
 * 诊断当前机器的语音合成后端是否可用。
 *   node scripts/diag-tts.cjs
 */
const crypto = require('crypto');
const vo = require('../dist/main/core/voiceover.js');

const hex = (b) => Buffer.from(b).toString('hex');
const revHex = (b) => Buffer.from(Buffer.from(b).subarray(0, 8)).reverse().toString('hex').toUpperCase();

console.log('=== TTS 诊断 ===');
const d = vo.ttsDiagnostics();
console.log(JSON.stringify(d, null, 2));

console.log('\n=== dbid 溯源 ===');
for (const t of ['小镇姑娘', 'ONOI', 'KMCY']) {
  const dbid = vo.dbidFromText(t);
  console.log(`  md5(${JSON.stringify(t)})[:8] = ${hex(dbid)}  → 语音文件名 ${revHex(dbid)}.wav`);
}
console.log('  参考：设备上 ONOI dbid=3c25541636239276 → 769223361654253C.wav');
console.log('       设备上 KMCY dbid=c6ab8884aefd107a → 7A10FDAE8488ABC6.wav');

(async () => {
  console.log('\n=== 实际合成一段中文 ===');
  try {
    const r = await vo.synthesize('小镇姑娘', { rate: 22050, speed: 0 });
    console.log(`  ✓ 成功：backend=${r.backend}  字节=${r.data.length}  rate=${r.info.rate}  channels=${r.info.channels}  bits=${r.info.bits}  appleContainer=${r.info.isAppleContainer}`);
  } catch (e) {
    console.log(`  ✗ 失败：${e.message}`);
  }
})();
