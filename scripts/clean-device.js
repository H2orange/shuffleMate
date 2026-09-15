/**
 * 清理设备上「数据库未引用」的孤儿文件（音频 + 语音）。
 * 只删 Music/F* 与 Speakable/Tracks 两个受控目录内的文件，其余路径一律拒绝。
 * 用法：node scripts/clean-device.js
 */
const fs = require('fs');
const path = require('path');
const fsx = require('../dist/main/core/fsx.js');
const it = require('../dist/main/core/itunessd.js');
const vo = require('../dist/main/core/voiceover.js');

const R = 'F:/';
const MUSIC = path.join(R, 'iPod_Control/Music');
const TRACKS = path.join(R, 'iPod_Control/Speakable/Tracks');
const SD = path.join(R, 'iPod_Control/iTunes/iTunesSD');

const model = it.parseSd(fs.readFileSync(SD));
const refAudio = new Set(model.tracks.map((t) => t.filename.replace(/^\/+/, '')));
const refVoice = new Set(model.tracks.map((t) => vo.voiceFilename(t.dbid).toLowerCase()));

let n = 0;
for (const d of fs.readdirSync(MUSIC, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  for (const f of fs.readdirSync(path.join(MUSIC, d.name))) {
    const rel = `iPod_Control/Music/${d.name}/${f}`;
    if (!refAudio.has(rel)) {
      fsx.removeFileSafe(path.join(R, rel), MUSIC);
      console.log('  删除音频孤儿 ' + rel);
      n++;
    }
  }
}
for (const f of fs.readdirSync(TRACKS)) {
  if (!refVoice.has(f.toLowerCase())) {
    fsx.removeFileSafe(path.join(TRACKS, f), TRACKS);
    console.log('  删除语音孤儿 ' + f);
    n++;
  }
}
fsx.flushVolume('F');

const countMusic = fs
  .readdirSync(MUSIC, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .reduce((a, d) => a + fs.readdirSync(path.join(MUSIC, d.name)).length, 0);
console.log(`清理完成：删除 ${n} 个。Music=${countMusic} Tracks=${fs.readdirSync(TRACKS).length} 曲目=${model.tracks.length}`);
