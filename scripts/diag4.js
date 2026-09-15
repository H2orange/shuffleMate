/* 诊断 v4：验证 0x130 = 帧和 − 最后 8 帧；stop_ms = round(帧和×8/码率×1000) */
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

console.log('文件'.padEnd(10) + '我们0x130'.padStart(11) + 'Apple'.padStart(11) + '差'.padStart(5) +
            '  我们stopMs'.padStart(13) + 'Apple'.padStart(11) + '差'.padStart(5) + '  最后8帧字节'.padStart(13));

let ok130 = 0;
let okStop = 0;
let n = 0;
for (const t of sd.tracks) {
  const rel = t.filename.replace(/^\/+/, '');
  const b = fs.readFileSync(path.join(ipod, rel));
  const id3v2 =
    b.toString('latin1', 0, 3) === 'ID3'
      ? 10 + (((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f))
      : 0;
  const id3v1 = b.subarray(b.length - 128, b.length - 125).toString('latin1') === 'TAG' ? 128 : 0;
  const limit = b.length - id3v1;

  let start = -1;
  for (let i = id3v2; i < limit - 4; i++) if (frameAt(b, i, limit)) { start = i; break; }

  let p = start;
  let sum = 0;
  const lens = [];
  let first = null;
  while (true) {
    const f = frameAt(b, p, limit);
    if (!f || p + f.len > limit) break;
    if (!first) first = f;
    lens.push(f.len);
    sum += f.len;
    p += f.len;
  }
  const last8 = lens.slice(-8).reduce((a, x) => a + x, 0);
  const my130 = sum - last8;
  const myStop = Math.round(((sum * 8) / first.bitrate) * 1000);

  n++;
  if (my130 === t.audioBytes) ok130++;
  if (Math.abs(myStop - t.stopMs) <= 1) okStop++;

  console.log(
    path.basename(rel).padEnd(10) +
      String(my130).padStart(11) +
      String(t.audioBytes).padStart(11) +
      String(my130 - t.audioBytes).padStart(5) +
      String(myStop).padStart(13) +
      String(t.stopMs).padStart(11) +
      String(myStop - t.stopMs).padStart(5) +
      String(last8).padStart(13),
  );
}

console.log(`\n0x130 精确命中 ${ok130}/${n}`);
console.log(`stopMs 命中(±1ms) ${okStop}/${n}`);
