/* 诊断：逐文件对比我们的解析结果与 Apple 写入 iTunesSD 的真实值 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const itunessd = require(path.join(ROOT, 'dist/main/core/itunessd.js'));
const { scanMusicFiles, findFirstIpod } = require(path.join(ROOT, 'dist/main/core/device.js'));

const ipod = findFirstIpod();
const sd = itunessd.parseSd(
  fs.readFileSync(path.join(ROOT, 'backups/20260915-111953/iTunes__iTunesSD')),
);

const BR1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BR2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function scanFrames(buf, start) {
  // 从 start 起逐帧走，返回 { offset, version, bitrate, rate, spf, channels, xing, frames, sumLen, count }
  let i = start;
  while (i < buf.length - 4) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) { i++; continue; }
    const ver = (buf[i + 1] >> 3) & 3;
    const layer = (buf[i + 1] >> 1) & 3;
    const brx = (buf[i + 2] >> 4) & 0xf;
    const srx = (buf[i + 2] >> 2) & 3;
    const pad = (buf[i + 2] >> 1) & 1;
    const ch = (buf[i + 3] >> 6) & 3;
    if (ver === 1 || layer !== 1 || brx === 0 || brx === 15 || srx === 3) { i++; continue; }
    const bitrate = (ver === 3 ? BR1 : BR2)[brx] * 1000;
    const rate = SR[ver][srx];
    const spf = ver === 3 ? 1152 : 576;
    const flen = Math.floor((spf / 8) * (bitrate / rate)) + pad;
    const mono = ch === 3;
    const side = ver === 3 ? (mono ? 17 : 32) : mono ? 9 : 17;
    const xingAt = i + 4 + side;
    const tag = buf.toString('latin1', xingAt, xingAt + 4);
    let xingFrames = null;
    if (tag === 'Xing' || tag === 'Info') {
      const flags = buf.readUInt32BE(xingAt + 4);
      if (flags & 1) xingFrames = buf.readUInt32BE(xingAt + 8);
    }
    return { offset: i, ver, bitrate, rate, spf, mono, xing: tag, xingFrames, flen };
  }
  return null;
}

console.log(
  '文件'.padEnd(10) +
    '大小'.padStart(10) +
    'ID3v2'.padStart(8) +
    'ID3v1'.padStart(7) +
    '帧@'.padStart(8) +
    '版本'.padStart(5) +
    '码率'.padStart(7) +
    '采样'.padStart(7) +
    'Xing'.padStart(6) +
    '帧数'.padStart(9) +
    '  我们ab'.padStart(11) +
    '  Apple ab'.padStart(11) +
    '  差'.padStart(7),
);

for (const t of sd.tracks) {
  const rel = t.filename.replace(/^\/+/, '');
  const p = path.join(ipod, rel);
  const b = fs.readFileSync(p);
  const id3v2 = b.toString('latin1', 0, 3) === 'ID3'
    ? 10 + (((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f))
    : 0;
  const id3v1 = b.subarray(b.length - 128, b.length - 125).toString('latin1') === 'TAG' ? 128 : 0;
  const f = scanFrames(b, id3v2);
  const mine = b.length - f.offset - id3v1;
  console.log(
    path.basename(rel).padEnd(10) +
      String(b.length).padStart(10) +
      String(id3v2).padStart(8) +
      String(id3v1).padStart(7) +
      String(f.offset).padStart(8) +
      String(f.ver === 3 ? 'MPEG1' : 'MPEG2').padStart(5) +
      String(f.bitrate / 1000).padStart(7) +
      String(f.rate).padStart(7) +
      String(f.xing || '-').padStart(6) +
      String(f.xingFrames ?? '-').padStart(9) +
      String(mine).padStart(11) +
      String(t.audioBytes).padStart(11) +
      String(mine - t.audioBytes).padStart(7),
  );
}

console.log('\n前 16 字节：');
for (const t of sd.tracks) {
  const b = fs.readFileSync(path.join(ipod, t.filename.replace(/^\/+/, '')));
  console.log('  ' + path.basename(t.filename).padEnd(10) + b.subarray(0, 16).toString('hex', 0, 16).match(/../g).join(' ') + '   ' + JSON.stringify(b.subarray(0, 4).toString('latin1')));
}

console.log('\n文件末尾 16 字节：');
for (const t of sd.tracks) {
  const b = fs.readFileSync(path.join(ipod, t.filename.replace(/^\/+/, '')));
  const tail = b.subarray(b.length - 16);
  console.log('  ' + path.basename(t.filename).padEnd(10) + tail.toString('hex').match(/../g).join(' ') + '   ' + JSON.stringify(tail.toString('latin1')));
}
