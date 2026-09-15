/**
 * 实机端到端验证：走应用真正的同步引擎，在真实设备上跑完整的
 * 「导入 → 自动生成中文 VoiceOver → 删除 → 回到原状」循环。
 *
 * 之所以不用手写字节而调用 syncDevice：GUI 点「同步」时执行的就是这个函数，
 * 这里验证通过，等于验证了界面按钮背后的完整通路。
 *
 * 测试完必须能回到**逐字节一致的原始数据库**，否则视为失败。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = 'F:/';
const BACKUPS = path.join(__dirname, '..', 'backups');
const PRISTINE = path.join(BACKUPS, '20260915-111953', 'iTunes__iTunesSD');

const sync = require('../dist/main/core/sync.js');
const device = require('../dist/main/core/device.js');
const fsx = require('../dist/main/core/fsx.js');
const vo = require('../dist/main/core/voiceover.js');
const audio = require('../dist/main/core/audio.js');

const SD = path.join(ROOT, 'iPod_Control/iTunes/iTunesSD');
const TRACKS = path.join(ROOT, 'iPod_Control/Speakable/Tracks');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
}
function hr(t) {
  console.log('\n' + '─'.repeat(66) + '\n' + t + '\n' + '─'.repeat(66));
}

/** 给 MP3 前置一个 ID3v2.3 TIT2 中文标题（UTF-16 + BOM） */
function prependId3Title(mp3, title) {
  const text = Buffer.from('\uFEFF' + title, 'utf16le');
  const body = Buffer.concat([Buffer.from([0x01]), text]);
  const frame = Buffer.alloc(10);
  frame.write('TIT2', 0, 'ascii');
  frame.writeUInt32BE(body.length, 4);
  frame.writeUInt16BE(0, 8);
  const payload = Buffer.concat([frame, body]);
  const size = payload.length;
  const ss = (n) => Buffer.from([(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f]);
  const head = Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.from([3, 0, 0]), ss(size)]);
  return Buffer.concat([head, payload, mp3]);
}

function snapshotVoiceMtimes() {
  const m = new Map();
  for (const f of fs.readdirSync(TRACKS)) {
    const st = fs.statSync(path.join(TRACKS, f));
    m.set(f.toLowerCase(), `${st.size}|${Math.round(st.mtimeMs)}`);
  }
  return m;
}

(async () => {
  // ---------------------------------------------------------------- 基线
  hr('A  基线：确认设备是完整的 13 首且无任何残留');
  if (!fsx.exists(SD)) throw new Error('设备未连接');
  const pristine = fs.readFileSync(PRISTINE);
  const base = device.loadLibrary(ROOT, false);
  const baseFiles = fs.readdirSync(TRACKS).map((f) => f.toLowerCase());
  check('数据库 13 首', base.model.tracks.length === 13, `实际 ${base.model.tracks.length}`);
  check('Music/ 正好 13 个音频', base.files.size === 13, `实际 ${base.files.size}`);
  check('无孤儿音频文件', base.orphanFiles === 0, `实际 ${base.orphanFiles}`);
  check('与原始模板逐字节一致', fs.readFileSync(SD).equals(pristine));
  check('语音目录正好 13 个文件', baseFiles.length === 13, `实际 ${baseFiles.length}`);
  const baseVoiceNames = new Set(
    base.model.tracks.map((t) => vo.voiceFilename(t.dbid).toLowerCase()),
  );
  const strayVoice = baseFiles.filter((f) => !baseVoiceNames.has(f));
  check('无孤儿语音文件', strayVoice.length === 0, strayVoice.join(','));

  // 基线不干净就直接停 —— 否则后面的差异比对全是噪声
  if (base.model.tracks.length !== 13 || base.orphanFiles !== 0 || strayVoice.length !== 0) {
    console.log('\n  基线不干净，先清理设备再重跑（脚本拒绝在脏基线上做差异比对）。');
    process.exit(3);
  }
  const backupsBefore = fs.readdirSync(BACKUPS).length;

  const baseVoice = snapshotVoiceMtimes();
  const baseIds = base.tracks.map((t) => t.id).sort().join(',');
  const idsBefore = new Set(base.tracks.map((t) => t.id));

  // 选一个源文件（设备上最小的那首），复制到临时目录，伪装成用户的本地文件
  const srcRel = base.tracks
    .slice()
    .sort((a, b) => a.fileSize - b.fileSize)[0].filename;
  const srcAbs = path.join(ROOT, srcRel);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipod-e2e-'));
  const TEST_TITLE = '端到端测试曲目';
  const localMp3 = path.join(tmpDir, 'local-test.mp3');
  fs.writeFileSync(localMp3, prependId3Title(fs.readFileSync(srcAbs), TEST_TITLE));
  console.log(`\n  源文件 : ${srcRel}（复制到临时目录并注入中文标题）`);
  console.log(`  临时目录: ${tmpDir}`);

  const localInfo = audio.probeAudioFile(localMp3);
  check('测试文件可被解析', localInfo.durationMs > 0, `${Math.round(localInfo.durationMs / 1000)}s`);
  check('中文 ID3 标题被读出', localInfo.tag.title === TEST_TITLE, `读到「${localInfo.tag.title}」`);

  // 预测新曲目将得到的 dbid / 语音文件名，看看目标是否已被占用
  const expectedTitle = localInfo.tag.title || path.basename(localMp3).replace(/\.[^.]+$/, '');
  const expectedDbid = vo.dbidFromText(expectedTitle);
  const expectedVoice = vo.voiceFilename(expectedDbid);
  console.log(`\n  预期 dbid    : ${expectedDbid.toString('hex')}`);
  console.log(`  预期语音名   : ${expectedVoice}`);
  console.log(`  基线语音文件数: ${baseVoice.size}`);
  console.log(`  该语音名是否已存在: ${baseVoice.has(expectedVoice.toLowerCase()) ? '是（会被判定为已存在而跳过）' : '否'}`);
  const referenced = new Set(
    base.tracks.map((t) => vo.voiceFilename(Buffer.from(t.id, 'hex')).toLowerCase()),
  );
  const orphanVoice = [...baseVoice.keys()].filter((k) => !referenced.has(k));
  console.log(`  设备上未被引用的语音（孤儿）: ${orphanVoice.length} 个`);
  for (const k of orphanVoice) console.log(`    ! ${k}  ${baseVoice.get(k)}`);

  // ---------------------------------------------------------------- 导入
  hr('B  导入：调用 syncDevice（= GUI 同步按钮背后的函数）');
  const events = [];
  const r1 = await sync.syncDevice(ROOT, BACKUPS, {
    addSources: [localMp3],
    generateVoiceover: true,
    enableVoiceover: true,
    onProgress: (p) => events.push(`${p.phase}:${p.message}`),
  });
  check('added = 1', r1.added === 1, `实际 ${r1.added}`);
  check('voiceoverCreated = 1', r1.voiceoverCreated === 1,
    `实际 created=${r1.voiceoverCreated} skipped=${r1.voiceoverSkipped}`);
  check('removed = 0', r1.removed === 0);
  check('已自动备份旧数据库', !!r1.backupPath, r1.backupPath || '');
  console.log(`  语音统计: 新建 ${r1.voiceoverCreated} · 沿用 ${r1.voiceoverSkipped}`);
  console.log(`  警告 ${r1.warnings.length} 条`);
  r1.warnings.forEach((w) => console.log(`    ! ${w}`));
  console.log(`  进度事件 ${events.length} 条`);

  // ---------------------------------------------------------------- 校验新增
  hr('C  校验：新曲目在设备上是否正确落盘');
  const after1 = device.loadLibrary(ROOT, false);
  check('数据库变为 14 首', after1.model.tracks.length === 14, `实际 ${after1.model.tracks.length}`);
  check('孤儿文件 0（新文件已被数据库引用）', after1.orphanFiles === 0, `实际 ${after1.orphanFiles}`);

  const addedView = after1.tracks.find((t) => !idsBefore.has(t.id));
  check('能定位到新增曲目', !!addedView);
  if (!addedView) throw new Error('未能定位新增曲目');

  console.log(`  新曲目 : ${addedView.filename}`);
  console.log(`  标题   : ${addedView.title}（来源 ${addedView.source}）`);
  console.log(`  时长   : ${Math.round(addedView.durationMs / 1000)}s`);
  console.log(`  dbid   : ${addedView.id}`);

  const newAbs = path.join(ROOT, addedView.filename);
  check('音频文件已写入设备', fs.existsSync(newAbs));
  check('大小与原文件一致', fs.statSync(newAbs).size === fs.statSync(localMp3).size,
    `${fs.statSync(newAbs).size} B`);
  check('落在 Music/F* 目录内', /^iPod_Control\/Music\/F\d\d\/[A-Z]{4}\.mp3$/.test(addedView.filename));
  check('数据库里时长与实际解析一致',
    Math.abs(after1.model.tracks.find((t) => t.dbid.toString('hex') === addedView.id).stopMs - localInfo.durationMs) <= 2);

  // 新建的曲目记录应沿用原曲目的 albumid/artistid（无标签时同桶）
  const newRec = after1.model.tracks.find((t) => t.dbid.toString('hex') === addedView.id);
  const origRec = base.model.tracks[0];
  check('新记录 pregap = 528（Apple 常量）', newRec.pregap === 528, `实际 ${newRec.pregap}`);
  check('新记录 filetype = 1（MP3）', newRec.filetype === 1);
  check('albumid 沿用存量曲目', newRec.albumid === origRec.albumid, `${newRec.albumid}`);

  // ---------------------------------------------------------------- 校验语音
  hr('D  校验：VoiceOver 语音');
  const voiceName = vo.voiceFilename(Buffer.from(addedView.id, 'hex'));
  const voicePath = path.join(TRACKS, voiceName);
  console.log(`  期望文件名 : ${voiceName}`);
  check('语音文件已生成', fsx.exists(voicePath));
  check('数据库里标记 hasVoiceover = true', addedView.hasVoiceover);

  if (fsx.exists(voicePath)) {
    const wav = fs.readFileSync(voicePath);
    const info = vo.parseWav(wav);
    check('可被解析为 WAV', !!info);
    check('data 块恰好落在 4096 字节偏移（Apple 容器）', info.isAppleContainer,
      `actual offset ${info.dataOffset}`);
    check('含 FLLR 填充块', wav.slice(0x24, 0x28).toString('ascii') === 'FLLR');
    check('格式 22050Hz 单声道 16bit PCM',
      info.rate === 22050 && info.channels === 1 && info.bits === 16 && info.pcm,
      `${info.rate}Hz ${info.channels}ch ${info.bits}bit pcm=${info.pcm}`);
    console.log(`  语音时长 : ${info.duration.toFixed(2)}s，${wav.length} B`);
  }

  const voiceAfter = snapshotVoiceMtimes();
  const changed = [...voiceAfter.entries()].filter(([k, v]) => baseVoice.has(k) && baseVoice.get(k) !== v);
  const brandNew = [...voiceAfter.keys()].filter((k) => !baseVoice.has(k));
  check('原有语音文件一个都没被改写', changed.length === 0,
    changed.length ? changed.map((c) => c[0]).join(',') : '');
  check('本轮只新增了 1 个语音文件', brandNew.length === 1, brandNew.join(','));

  // ---------------------------------------------------------------- 删除
  hr('E  删除：移除刚才导入的曲目');
  const r2 = await sync.syncDevice(ROOT, BACKUPS, {
    removeIds: [addedView.id],
    generateVoiceover: true,
  });
  check('removed = 1', r2.removed === 1, `实际 ${r2.removed}`);
  check('音频文件已从设备删除', !fs.existsSync(newAbs));
  check('语音文件一并清理', !fs.existsSync(voicePath));

  // ---------------------------------------------------------------- 回到原状
  hr('F  收尾：确认设备回到原始状态');
  const final = device.loadLibrary(ROOT, false);
  check('数据库回到 13 首', final.model.tracks.length === 13, `实际 ${final.model.tracks.length}`);
  check('Music/ 回到 13 个文件', final.files.size === 13, `实际 ${final.files.size}`);
  check('孤儿文件 0', final.orphanFiles === 0, `实际 ${final.orphanFiles}`);
  check('曲目 id 集合与基线完全一致', final.tracks.map((t) => t.id).sort().join(',') === baseIds);
  const finalBuf = fs.readFileSync(SD);
  check('iTunesSD 与原始模板逐字节一致', finalBuf.equals(pristine),
    finalBuf.equals(pristine) ? `${finalBuf.length} B` : `${finalBuf.length} B / 模板 ${pristine.length} B`);
  const finalVoice = snapshotVoiceMtimes();
  const added = [...finalVoice.keys()].filter((k) => !baseVoice.has(k));
  const removedV = [...baseVoice.keys()].filter((k) => !finalVoice.has(k));
  check('语音目录无新增残留', added.length === 0, added.join(','));
  check('语音目录无丢失', removedV.length === 0, removedV.join(','));
  const backupsAfter = fs.readdirSync(BACKUPS).length;
  check('恰好产生 2 次自动备份（导入 + 删除各一次）', backupsAfter - backupsBefore === 2,
    `${backupsBefore} → ${backupsAfter}`);

  fs.rmSync(tmpDir, { recursive: true, force: true });

  hr(`结果：通过 ${pass} · 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\n执行失败：', e && e.stack ? e.stack : e);
  process.exit(2);
});
