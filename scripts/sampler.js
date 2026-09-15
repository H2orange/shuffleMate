/**
 * 高频目录采样器：每 400ms 记录一次 Music/ 与 Speakable/Tracks 的文件集合，
 * 只打印发生变化的时刻。用于和另一个进程的行为做时间对齐。
 * 用法：node scripts/sampler.js <持续秒数>
 */
const fs = require('fs');
const path = require('path');

const SECS = Number(process.argv[2] || 60);
const R = 'F:/';
const MUSIC = path.join(R, 'iPod_Control/Music');
const TRACKS = path.join(R, 'iPod_Control/Speakable/Tracks');

const t0 = Date.now();
const stamp = () => new Date().toISOString().slice(11, 23);

function list(dir) {
  const out = [];
  let ds;
  try {
    ds = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of ds) {
    if (d.isDirectory()) {
      try {
        for (const f of fs.readdirSync(path.join(dir, d.name))) out.push(`${d.name}/${f}`);
      } catch {}
    } else out.push(d.name);
  }
  return out.sort();
}

let prevM = list(MUSIC);
let prevT = list(TRACKS);
console.log(`[${stamp()}] 采样开始  Music=${prevM.length} Tracks=${prevT.length}`);

const iv = setInterval(() => {
  const m = list(MUSIC);
  const t = list(TRACKS);
  const mAdd = m.filter((x) => !prevM.includes(x));
  const mDel = prevM.filter((x) => !m.includes(x));
  const tAdd = t.filter((x) => !prevT.includes(x));
  const tDel = prevT.filter((x) => !t.includes(x));
  if (mAdd.length || mDel.length || tAdd.length || tDel.length) {
    const d = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `[${stamp()}] +${d}s  Music ${prevM.length}->${m.length}` +
        (mAdd.length ? `  新增[${mAdd}]` : '') +
        (mDel.length ? `  消失[${mDel}]` : '') +
        `  | Tracks ${prevT.length}->${t.length}` +
        (tAdd.length ? `  新增[${tAdd}]` : '') +
        (tDel.length ? `  消失[${tDel}]` : ''),
    );
    prevM = m;
    prevT = t;
  }
}, 400);

setTimeout(() => {
  clearInterval(iv);
  console.log(`[${stamp()}] 采样结束  Music=${prevM.length} Tracks=${prevT.length}`);
}, SECS * 1000);
