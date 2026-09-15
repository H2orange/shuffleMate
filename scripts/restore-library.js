/**
 * 把设备从「最小验证留下的 3 首状态」恢复成完整的 13 首曲库。
 *
 * 做法：拿验证前备份的原始 iTunesSD 当模板，解析 → 重建 → 走应用自己的
 * 安全写入通道写回（备份 → 原子写 → 回读校验 → 刷盘）。
 *
 * 之所以不是简单 cp：这样写回去的字节要经得起 buildSd 的往返校验，
 * 相当于顺带证明「我们的构建器能无损复现 Apple 的原始数据库」。
 */
const fs = require('fs');
const path = require('path');

const ROOT = 'F:/';
const BACKUPS = path.join(__dirname, '..', 'backups');
const PRISTINE = path.join(BACKUPS, '20260915-111953', 'iTunes__iTunesSD');

const it = require('../dist/main/core/itunessd.js');
const fsx = require('../dist/main/core/fsx.js');
const vo = require('../dist/main/core/voiceover.js');
const device = require('../dist/main/core/device.js');

const SD = path.join(ROOT, 'iPod_Control/iTunes/iTunesSD');
const TRACKS = path.join(ROOT, 'iPod_Control/Speakable/Tracks');

function hr(t) {
  console.log('\n' + '─'.repeat(64) + '\n' + t + '\n' + '─'.repeat(64));
}

// ---------------------------------------------------------------- 0. 前置检查
hr('0  前置检查');
if (!fsx.exists(SD)) throw new Error(`找不到设备数据库：${SD}`);
const pristine = fs.readFileSync(PRISTINE);
const target = it.parseSd(pristine);
if (!it.buildSd(target).equals(pristine)) {
  throw new Error('模板往返校验失败，中止');
}
console.log(`设备         : ${ROOT}`);
console.log(`模板备份     : ${PRISTINE}`);
console.log(`模板曲目数   : ${target.tracks.length}`);
console.log(`模板 VoiceOver: ${target.root.voiceover ? '开' : '关'}`);

// ---------------------------------------------------------------- 1. 现状
hr('1  当前设备状态（恢复前）');
const before = device.loadLibrary(ROOT, false);
console.log(`数据库声明 : ${before.model.tracks.length} 首`);
console.log(`Music/ 文件 : ${before.files.size} 个`);
console.log(`孤儿文件    : ${before.orphanFiles} 个（数据库未引用的）`);
const beforeBuf = fs.readFileSync(SD);
console.log(`iTunesSD    : ${beforeBuf.length} 字节，mtime ${fs.statSync(SD).mtime.toISOString()}`);

if (before.model.tracks.length === target.tracks.length) {
  console.log('\n已经是完整状态，无需恢复。');
  process.exit(0);
}

// ---------------------------------------------------------------- 2. 备份
hr('2  备份当前数据库');
const saved = fsx.backupFile(SD, BACKUPS, 'prechange', 'iTunesSD');
console.log(`已备份 → ${saved}`);

// ---------------------------------------------------------------- 3. 重建并写入
hr('3  重建 13 首数据库并原子写入');
const rebuilt = it.buildSd(target);
fsx.atomicWriteFile(SD, rebuilt);
console.log(`写入 ${rebuilt.length} 字节（原子替换 + fsync）`);

// ---------------------------------------------------------------- 4. 回读校验
hr('4  回读校验');
const after = fs.readFileSync(SD);
if (!after.equals(pristine)) throw new Error('回读字节与模板不一致，中止！');
console.log('✓ 设备上的字节与原始模板逐字节一致');
const reloaded = device.loadLibrary(ROOT, false);
console.log(`✓ 重新解析：${reloaded.model.tracks.length} 首，VoiceOver ${reloaded.model.root.voiceover ? '开' : '关'}`);
if (reloaded.orphanFiles !== 0) {
  console.log(`! 仍有 ${reloaded.orphanFiles} 个孤儿文件`);
} else {
  console.log('✓ 孤儿文件 0 个（文件与数据库完全对齐）');
}

// ---------------------------------------------------------------- 5. 语音核对
hr('5  VoiceOver 语音核对');
let missing = 0;
const existing = new Set(
  fs.existsSync(TRACKS) ? fs.readdirSync(TRACKS).map((f) => f.toLowerCase()) : [],
);
for (const t of target.tracks) {
  const name = vo.voiceFilename(t.dbid);
  const ok = existing.has(name.toLowerCase());
  if (!ok) missing++;
  console.log(`  ${ok ? '✓' : '✗'} ${path.basename(t.filename).padEnd(9)} → ${name}`);
}
console.log(`\n缺失 ${missing} 个 / 共 ${target.tracks.length} 个`);
if (missing > 0) {
  console.log('（存量语音应全部命中 —— 沿用原 dbid 的意义就在这里）');
}

// ---------------------------------------------------------------- 6. 刷盘
hr('6  刷盘');
const letter = ROOT.replace(/:.*$/, '');
const flushed = fsx.flushVolume(letter);
console.log(flushed ? '✓ 卷级刷盘成功' : '! 卷级刷盘失败（需管理员），已做文件级刷盘');

hr('完成');
console.log('设备已恢复为完整 13 首。断开前请务必「安全弹出」。');
