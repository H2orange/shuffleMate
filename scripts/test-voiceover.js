/* 语音合成链路验证：Node → PowerShell System.Speech → Apple 容器重打包 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const vo = require(path.join(ROOT, 'dist/main/core/voiceover.js'));

(async () => {
  console.log('PowerShell 路径:', vo.powershellPath());
  console.log('存在:', fs.existsSync(vo.powershellPath()));

  console.log('\n=== 可用语音 ===');
  let voices = [];
  try {
    voices = vo.listVoices();
    for (const v of voices) console.log(`  ${v.name}  [${v.culture}] ${v.gender}`);
  } catch (e) {
    console.log('  枚举失败:', e.message);
    process.exit(1);
  }
  console.log('默认选用:', vo.pickVoice());

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vo-test-'));
  const text = '2009年06月六级听力真题';
  try {
    const t0 = Date.now();
    const { data, info } = await vo.synthesize(text, { rate: 22050 });
    const ms = Date.now() - t0;
    const out = path.join(tmp, 'out.wav');
    fs.writeFileSync(out, data);

    console.log('\n=== 合成结果 ===');
    console.log(`  文本      ${text}`);
    console.log(`  耗时      ${ms} ms`);
    console.log(`  文件      ${data.length} B`);
    console.log(`  头部      ${info.dataOffset} B  (Apple 容器 = ${info.dataOffset === 4096})`);
    console.log(`  格式      ${info.channels}ch ${info.rate}Hz ${info.bits}bit PCM=${info.pcm}`);
    console.log(`  时长      ${info.duration.toFixed(2)} s`);

    const parsed = vo.parseWav(data);
    console.log(`  自检      头部=${parsed.dataOffset} 时长=${parsed.duration.toFixed(2)}s`);

    // 与设备上 Apple 文件逐字节比对头部（仅长度字段允许不同）
    const { findFirstIpod } = require(path.join(ROOT, 'dist/main/core/device.js'));
    const ipod = findFirstIpod();
    if (ipod) {
      const dir = path.join(ipod, 'iPod_Control/Speakable/Tracks');
      const f = fs.readdirSync(dir).find((x) => x.endsWith('.wav'));
      if (f) {
        const apple = fs.readFileSync(path.join(dir, f)).subarray(0, 4096);
        const mine = data.subarray(0, 4096);
        const diffs = [];
        for (let i = 0; i < 4096; i++) if (apple[i] !== mine[i]) diffs.push(i);
        console.log(`\n=== 与 Apple 文件「${f}」头部比对 ===`);
        console.log(`  差异字节: ${diffs.length === 0 ? '无（完全一致）' : diffs.map((i) => `@${i}`).join(' ')}`);
        console.log(`  说明: 仅 riff_size(4..8) 与 data_size(4092..4096) 允许不同`);
      }
    }

    // 命名规则
    const dbid = vo.dbidFromText(text);
    console.log(`\n=== 命名 ===`);
    console.log(`  dbid      ${dbid.toString('hex')}`);
    console.log(`  文件名    ${vo.voiceFilename(dbid)}`);
    console.log(`\n输出文件: ${out}`);
  } finally {
    // 保留输出供人工试听
  }
})().catch((e) => {
  console.error('失败:', e);
  process.exit(1);
});
