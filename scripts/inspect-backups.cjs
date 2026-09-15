/**
 * 诊断脚本：盘点 backups/ 下所有 iTunesSD 备份 + 可选的在线设备。
 *
 * 输出每份数据库的曲目数、VoiceOver 总开关、逐曲 dbid 与期望的语音文件名，
 * 用来回答「为什么某首歌没有 VoiceOver」这类问题。
 *
 *   node scripts/inspect-backups.cjs            # 只看备份
 *   node scripts/inspect-backups.cjs F:/        # 额外看在线设备
 */
const fs = require('fs');
const path = require('path');

const { parseSd } = require('../dist/main/core/itunessd.js');

const revHex = (b) => Buffer.from(Buffer.from(b).subarray(0, 8)).reverse().toString('hex').toUpperCase();
const hex = (b) => Buffer.from(b).toString('hex');

function describe(label, buf) {
  let m;
  try {
    m = parseSd(buf);
  } catch (e) {
    console.log(`\n=== ${label}  size=${buf.length}  ✗ 解析失败: ${e.message}`);
    return null;
  }
  const vo = m.root.voiceover ? 1 : 0;
  console.log(`\n=== ${label}`);
  console.log(`    size=${buf.length}  tracks=${m.tracks.length}  VoiceOver总开关=${vo}${vo ? '' : '  ⚠️ 关闭（整机静音）'}`);
  m.tracks.forEach((t, i) => {
    console.log(`    ${String(i).padStart(2)}  ${t.filename}  dbid=${hex(t.dbid)}  → ${revHex(t.dbid)}.wav`);
  });
  return m;
}

// ---- 1. 备份 ----
const backupsDir = path.join(__dirname, '..', 'backups');
const dirs = fs.readdirSync(backupsDir).filter((d) => {
  try {
    return fs.statSync(path.join(backupsDir, d)).isDirectory();
  } catch {
    return false;
  }
}).sort();

console.log(`扫描 ${dirs.length} 个备份目录：`);
const sets = [];
for (const d of dirs) {
  // 兼容两种命名：iTunesSD / iTunes__iTunesSD
  for (const name of ['iTunesSD', 'iTunes__iTunesSD']) {
    const p = path.join(backupsDir, d, name);
    if (fs.existsSync(p)) {
      const m = describe(`${d}/${name}`, fs.readFileSync(p));
      if (m) sets.push({ dir: d, m });
    }
  }
}

// ---- 2. 变化时间线（曲目集合差异）----
console.log('\n\n========== 曲目集合变化时间线 ==========');
let prev = null;
for (const s of sets) {
  const cur = {
    vo: s.m.root.voiceover ? 1 : 0,
    ids: new Set(s.m.tracks.map((t) => hex(t.dbid))),
    names: new Map(s.m.tracks.map((t) => [hex(t.dbid), t.filename])),
  };
  if (prev) {
    const added = [...cur.ids].filter((x) => !prev.ids.has(x));
    const removed = [...prev.ids].filter((x) => !cur.ids.has(x));
    if (added.length || removed.length || prev.vo !== cur.vo) {
      console.log(`${s.dir}:  曲目 ${prev.ids.size} → ${cur.ids.size}，VO开关 ${prev.vo} → ${cur.vo}`);
      added.forEach((x) => console.log(`    + 新增 dbid=${x}  ${cur.names.get(x)}`));
      removed.forEach((x) => console.log(`    - 移除 dbid=${x}  ${prev.names.get(x)}`));
    }
  }
  prev = cur;
}

// ---- 3. 可选的在线设备 ----
const root = process.argv[2];
if (root) {
  console.log(`\n\n========== 在线设备 ${root} ==========`);
  const sd = path.join(root, 'iPod_Control', 'iTunes', 'iTunesSD');
  if (fs.existsSync(sd)) {
    const m = describe('设备 iTunesSD', fs.readFileSync(sd));
    const tracksDir = path.join(root, 'iPod_Control', 'Speakable', 'Tracks');
    console.log(`\n    Speakable/Tracks: ${tracksDir}`);
    let files = [];
    try {
      files = fs.readdirSync(tracksDir).filter((f) => /^[0-9A-Fa-f]{16}\.wav$/.test(f));
    } catch {
      console.log('    ✗ 目录不存在');
    }
    console.log(`    语音文件 ${files.length} 个`);
    if (m) {
      const have = new Set(files.map((f) => f.toUpperCase()));
      const missing = m.tracks.filter((t) => !have.has(revHex(t.dbid)));
      const used = new Set(m.tracks.map((t) => revHex(t.dbid)));
      const orphan = files.filter((f) => !used.has(f.toUpperCase()));
      console.log(`\n    ✓ 有语音: ${m.tracks.length - missing.length}/${m.tracks.length}`);
      missing.forEach((t) => console.log(`    ✗ 缺语音: ${t.filename}  期望 ${revHex(t.dbid)}.wav`));
      orphan.forEach((f) => console.log(`    ? 无主语音: ${f}`));
    }
  } else {
    console.log(`    ✗ 找不到 ${sd}`);
  }
}
