/* 诊断 v3：JSON 输出，杜绝列错位误判 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const itunessd = require(path.join(ROOT, 'dist/main/core/itunessd.js'));
const { findFirstIpod } = require(path.join(ROOT, 'dist/main/core/device.js'));

const ipod = findFirstIpod();
const sd = itunessd.parseSd(
  fs.readFileSync(path.join(ROOT, 'backups', '20260915-111953', 'iTunes__iTunesSD')),
);

const BR1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BR2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function frameAt(buf, i, limit) {
  if (i + 4 > limit) return null;
  if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) return null;
  const ver = (buf[i + 1] >> 3) & 3;
  const layer = (buf[i + 1] >> 1) & 3;
  const brx = (buf[i + 2] >> 4) & 0xf;
  const srx = (buf[i + 2] >> 2) & 3;
  const pad = (buf[i + 2] >> 1) & 1;
  const ch = (buf[i + 3] >> 6) & 3;
  if (ver === 1 || layer !== 1 || brx === 0 || brx === 15 || srx === 3) return null;
  const bitrate = (ver === 3 ? BR1 : BR2)[brx] * 1000;
  const rate = SR[ver][srx];
  const spf = ver === 3 ? 1152 : 576;
  return { ver, bitrate, rate, spf, len: Math.floor((spf / 8) * (bitrate / rate)) + pad, mono: ch === 3 };
}

/** 只在 [from, limit) 内走帧；要求整帧落在 limit 之内才算完整 */
function walk(buf, from, limit) {
  let p = from;
  let sum = 0;
  let n = 0;
  while (true) {
    const f = frameAt(buf, p, limit);
    if (!f) break;
    if (p + f.len > limit) {
      // 最后一帧不完整，不计入
      return { sum, n, tailBytes: limit - p, stopAt: p };
    }
    sum += f.len;
    n++;
    p += f.len;
  }
  return { sum, n, tailBytes: limit - p, stopAt: p };
}

const rows = [];
for (const t of sd.tracks) {
  const rel = t.filename.replace(/^\/+/, '');
  const b = fs.readFileSync(path.join(ipod, rel));
  const id3v2 =
    b.toString('latin1', 0, 3) === 'ID3'
      ? 10 + (((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f))
      : 0;
  const id3v1 = b.subarray(b.length - 128, b.length - 125).toString('latin1') === 'TAG' ? 128 : 0;
  const limit = b.length - id3v1;
  const stream = limit - id3v2;

  // 找首个有效帧
  let start = -1;
  for (let i = id3v2; i < limit - 4; i++) {
    if (frameAt(b, i, limit)) {
      start = i;
      break;
    }
  }
  const w = walk(b, start, limit);

  // 尾部连续相同字节
  let fillByte = b[limit - 1];
  let fillN = 0;
  while (fillN < limit && b[limit - 1 - fillN] === fillByte) fillN++;

  rows.push({
    file: path.basename(rel),
    fileSize: b.length,
    id3v2,
    id3v1,
    stream,
    frameStart: start,
    frameSum: w.sum,
    frameCount: w.n,
    stopAt: w.stopAt,
    tailBytes: w.tailBytes,
    tailFillByte: '0x' + fillByte.toString(16).padStart(2, '0'),
    tailFillN: fillN,
    streamMinusSum: stream - w.sum,
    apple130: t.audioBytes,
    sumMinusApple: w.sum - t.audioBytes,
    appleStopMs: t.stopMs,
  });
}

console.log(JSON.stringify(rows, null, 1));

// 关键比值：帧和与 0x130 的差，换算成「多少秒的音频」
console.log('\n=== 帧和 − Apple 0x130，折算为时间 ===');
for (const r of rows) {
  const bitrateBits =
    r.file === 'SBJT.mp3' || r.file === 'DQNL.mp3' || r.file === 'OOFR.mp3' ||
    r.file === 'VQCA.mp3' || r.file === 'WBSM.mp3' || r.file === 'AWWS.mp3' ||
    r.file === 'CGMU.mp3' || r.file === 'INUQ.mp3' || r.file === 'GAKR.mp3'
      ? 128000
      : r.file === 'DQMD.mp3'
        ? 64000
        : r.file === 'IEWX.mp3'
          ? 80000
          : 40000;
  const sec = (r.sumMinusApple * 8) / bitrateBits;
  console.log(
    `  ${r.file.padEnd(10)} 差 ${String(r.sumMinusApple).padStart(6)} 字节  = ${(sec * 1000).toFixed(1)} ms  = ${(sec / (1152 / (r.file === 'DQMD.mp3' || r.file === 'NEPE.mp3' || r.file === 'YTKZ.mp3' ? 22050 : 44100))).toFixed(2)} 帧`,
  );
}

const ratios = rows.map((r) => {
  const bitrateBits =
    r.file === 'DQMD.mp3' ? 64000 : r.file === 'IEWX.mp3' ? 80000 : r.file === 'NEPE.mp3' || r.file === 'YTKZ.mp3' ? 40000 : 128000;
  return (r.sumMinusApple * 8) / bitrateBits;
});
console.log('\n比值范围:', Math.min(...ratios).toFixed(4), '~', Math.max(...ratios).toFixed(4), '秒');
