/* 验证假设：Apple 的 0x130 = 完整 MPEG 帧字节和 − 尾部非音频填充 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const itunessd = require(path.join(ROOT, 'dist/main/core/itunessd.js'));
const { findFirstIpod } = require(path.join(ROOT, 'dist/main/core/device.js'));

const ipod = findFirstIpod();
const sd = itunessd.parseSd(
  fs.readFileSync(path.join(ROOT, 'backups/20260915-111951/iTunes__iTunesSD'.replace('111951', '111953'))),
);

const BR1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BR2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function frameAt(buf, i) {
  if (i + 4 > buf.length) return null;
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
  const len = Math.floor((spf / 8) * (bitrate / rate)) + pad;
  const mono = ch === 3;
  const side = ver === 3 ? (mono ? 17 : 32) : mono ? 9 : 17;
  return { ver, bitrate, rate, spf, len, mono, side };
}

function firstFrame(buf, from) {
  for (let i = from; i < buf.length - 4; i++) {
    if (frameAt(buf, i)) return i;
  }
  return -1;
}

/** 连续累加完整帧长度，遇到无效头即停 */
function sumFrames(buf, start) {
  let p = start;
  let sum = 0;
  let count = 0;
  let lastValid = start;
  while (p + 4 <= buf.length) {
    const f = frameAt(buf, p);
    if (!f) break;
    p += f.len;
    sum += f.len;
    count++;
    if (p <= buf.length) lastValid = p;
  }
  return { sum, count, end: lastValid, used: p };
}

/** 统计末尾连续相同字节（填充） */
function tailFiller(buf, end) {
  if (end <= 0) return { byte: -1, n: 0 };
  const b = buf[end - 1];
  let n = 0;
  while (n < end && buf[end - 1 - n] === b) n++;
  return { byte: b, n };
}

console.log(
  '文件'.padEnd(10) +
    '流字节'.padStart(10) +
    '帧和'.padStart(10) +
    '帧数'.padStart(7) +
    '尾填充'.padStart(9) +
    '填充字节'.padStart(9) +
    '流−帧和'.padStart(9) +
    '  Apple 0x130'.padStart(13) +
    ' 帧和−0x130'.padStart(12) +
    ' 0x130−(帧和−填充)'.padStart(18),
);

for (const t of sd.tracks) {
  const rel = t.filename.replace(/^\/+/, '');
  const b = fs.readFileSync(path.join(ipod, rel));
  const id3v2 =
    b.toString('latin1', 0, 3) === 'ID3'
      ? 10 + (((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f))
      : 0;
  const id3v1 = b.subarray(b.length - 128, b.length - 125).toString('latin1') === 'TAG' ? 128 : 0;
  const streamEnd = b.length - id3v1;
  const stream = streamEnd - id3v2;
  const start = firstFrame(b, id3v2);
  const sf = sumFrames(b, start);
  const filler = tailFiller(b, streamEnd);
  console.log(
    path.basename(rel).padEnd(10) +
      String(stream).padStart(10) +
      String(sf.sum).padStart(10) +
      String(sf.count).padStart(7) +
      String(filler.n).padStart(9) +
      '0x' + filler.byte.toString(16).padStart(2, '0') +
      String(stream - sf.sum).padStart(9) +
      String(t.audioBytes).padStart(13) +
      String(sf.sum - t.audioBytes).padStart(12) +
      String(t.audioBytes - (sf.sum - filler.n)).padStart(18),
  );
}
