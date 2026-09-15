/* eslint-disable no-console */
/**
 * 核心引擎回归测试（无界面，直接跑 Node）。
 *
 * 最高优先级的一条是 T1：把设备上 Apple 生成的 iTunesSD 解析后重新序列化，
 * 必须与原文件**逐字节完全一致**。这一条过了，才能说明"我们造出来的数据库
 * 设备一定能读"。
 *
 * 用法：node scripts/test-core.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const core = (name) => require(path.join(ROOT, 'dist', 'main', 'core', name));

const itunessd = core('itunessd');
const audio = core('audio');
const voiceover = core('voiceover');
const device = core('device');
const itunesdb = core('itunesdb');
const hotplug = core('hotplug');

const BACKUPS = path.join(ROOT, 'backups');
const ORIGINAL_SD = path.join(BACKUPS, '20260915-111953', 'iTunes__iTunesSD');
const PRECHANGE_SD = path.join(BACKUPS, '20260915-112331-prechange', 'iTunesSD');

let pass = 0;
let fail = 0;
let skip = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  \u2717 ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${'─'.repeat(64)}\n${title}\n${'─'.repeat(64)}`);
}

/** 仅作信息展示，不计入通过/失败 */
function mark(text) {
  console.log(`  · ${text}`);
}

function skipSection(title, why) {
  skip++;
  console.log(`\n[跳过] ${title} —— ${why}`);
}

function eqBuf(a, b) {
  return a.length === b.length && a.equals(b);
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return { at: i, a: a[i], b: b[i] };
  return null;
}

// ============================================================ T1 往返一致性

section('T1  iTunesSD 往返一致性（解析 → 重新序列化 → 逐字节比对）');

if (!fs.existsSync(ORIGINAL_SD)) {
  skipSection('T1', `找不到备份 ${ORIGINAL_SD}`);
} else {
  const orig = fs.readFileSync(ORIGINAL_SD);
  const model = itunessd.parseSd(orig);
  const rebuilt = itunessd.buildSd(model);

  check(
    `Apple 原始文件（13 首，${orig.length} B）逐字节一致`,
    eqBuf(orig, rebuilt),
    (() => {
      const d = firstDiff(orig, rebuilt);
      return d
        ? `长度 ${orig.length} vs ${rebuilt.length}，首个差异 @${d.at}: ${d.a} vs ${d.b}`
        : '';
    })(),
  );

  check('根头版本标记 = 0x02010001', model.root.version === 0x02010001, `实际 0x${model.root.version.toString(16)}`);
  check('曲目数 = 13', model.root.nTracks === 13, `实际 ${model.root.nTracks}`);
  check('播放列表数 = 1（shuffle 恒为 1）', model.root.nPlaylists === 1, `实际 ${model.root.nPlaylists}`);
  check('VoiceOver 总开关 = 1', model.root.voiceover === 1, `实际 ${model.root.voiceover}`);
  check('曲目头偏移 = 64', model.root.trackHeaderOffset === 64);
  check('播放列表区偏移 = 4972', model.root.playlistHeaderOffset === 4972, `实际 ${model.root.playlistHeaderOffset}`);
  check(
    '曲目文件名带前导 /',
    model.tracks.every((t) => t.filename.startsWith('/')),
    model.tracks[0]?.filename,
  );
  check('pregap 13 首恒为 528', model.tracks.every((t) => t.pregap === 528));
  check(
    'Master 播放列表 listtype = 1 且成员为 0..12',
    model.playlists[0].listtype === 1 && model.playlists[0].members.join(',') === model.tracks.map((_, i) => i).join(','),
  );

  // 重建成 5 首后仍必须往返一致，且播放列表成员要跟着重排
  const m2 = itunessd.withTracks(model, model.tracks.slice(0, 5));
  const b2 = itunessd.buildSd(m2);
  const p2 = itunessd.parseSd(b2);
  check('裁剪为 5 首后仍可往返', eqBuf(b2, itunessd.buildSd(p2)));
  check('裁剪后 nTracks 同步', p2.root.nTracks === 5 && p2.tracks.length === 5);
  check('裁剪后播放列表成员重排为 0..4', p2.playlists[0].members.join(',') === '0,1,2,3,4');
  check('裁剪后播放列表 nSongs 同步', p2.playlists[0].nSongs === 5);
  check('VoiceOver 开关在重建中被保留', p2.root.voiceover === 1);
  check('裁剪后主列表仍是 Master', p2.playlists[0].listtype === 1);

  // 清空全部曲目也必须能正常构建（用户可能想一次清空设备）
  const empty = itunessd.buildSd(itunessd.withTracks(model, []));
  const pe = itunessd.parseSd(empty);
  check('清空为 0 首后仍可往返', eqBuf(empty, itunessd.buildSd(pe)));
  check('清空后 nTracks = 0', pe.root.nTracks === 0 && pe.tracks.length === 0);
}

if (fs.existsSync(PRECHANGE_SD)) {
  const p = fs.readFileSync(PRECHANGE_SD);
  const m = itunessd.parseSd(p);
  check(`改动前备份（${p.length} B）逐字节一致`, eqBuf(p, itunessd.buildSd(m)));
}

// ============================================================ T2 VoiceOver 命名

section('T2  VoiceOver 文件名规则（dbid 倒序十六进制）');

check(
  'voiceFilename 与已知样例一致',
  voiceover.voiceFilename(Buffer.from('5cda284d1d1a1083', 'hex')) === '83101A1D4D28DA5C.wav',
  voiceover.voiceFilename(Buffer.from('5cda284d1d1a1083', 'hex')),
);
check(
  'dbidFromText 幂等',
  voiceover.dbidFromText('六级模拟试题 1').equals(voiceover.dbidFromText('六级模拟试题 1')),
);
check(
  'announceText 拼接标题与艺术家',
  voiceover.announceText('晴天', '周杰伦') === '晴天 - 周杰伦',
);

const ipodRoot = device.findFirstIpod();
if (!ipodRoot) {
  skipSection('T2b', '未检测到 iPod，无法核对设备上的真实语音文件名');
} else {
  const sd = itunessd.parseSd(fs.readFileSync(path.join(ipodRoot, 'iPod_Control/iTunes/iTunesSD')));
  let have = [];
  try {
    have = fs
      .readdirSync(path.join(ipodRoot, 'iPod_Control/Speakable/Tracks'))
      .map((f) => f.toLowerCase());
  } catch {
    /* 无语音目录 */
  }
  const expected = new Set(sd.tracks.map((t) => voiceover.voiceFilename(t.dbid).toLowerCase()));
  const waveFiles = have.filter((f) => /^[0-9a-f]{16}\.wav$/.test(f));
  const withVoice = sd.tracks.filter((t) =>
    expected.has(voiceover.voiceFilename(t.dbid).toLowerCase()),
  ).length;
  const orphan = waveFiles.filter((f) => !expected.has(f));

  // 语音是「有则播报、无则静音」的可选件：某首缺语音**未必是故障**
  // （写入当时后端不可用、或用户本就不想要播报），所以这里不把"缺语音"判失败。
  // 「TTS 后端是否可用」由 T9 把关 —— 那才是会成批制造缺语音的根因；
  // 这里只守住一条不会误伤正常状态的检查：**不该存在对不上任何曲目的语音文件**。
  check(
    `设备上 ${waveFiles.length} 个语音文件全部能对应到曲目`,
    orphan.length === 0,
    orphan.length ? `无主：${orphan.slice(0, 8).join('、')}` : '',
  );
  mark(`设备 ${sd.tracks.length} 首：有语音 ${withVoice}，缺语音 ${sd.tracks.length - withVoice}`);
}

// ============================================================ T3 Apple WAV 容器

section('T3  Apple VoiceOver WAV 容器（固定 4096 字节头）');

let appleWavPath = null;
if (ipodRoot) {
  try {
    const dir = path.join(ipodRoot, 'iPod_Control/Speakable/Tracks');
    const f = fs.readdirSync(dir).find((x) => x.toLowerCase().endsWith('.wav'));
    if (f) appleWavPath = path.join(dir, f);
  } catch {
    /* ignore */
  }
}

if (!appleWavPath) {
  skipSection('T3', '设备上找不到参考 WAV');
} else {
  const info = voiceover.parseWav(appleWavPath);
  check(`Apple WAV 头部 = 4096 字节（实际 ${info.dataOffset}）`, info.dataOffset === 4096);
  check('Apple WAV 为 PCM', info.pcm === true);
  check('Apple WAV 单声道 16 位', info.channels === 1 && info.bits === 16);

  // 用同一份 PCM 重新封装，头部必须与 Apple 完全一致（只有两个长度字段允许不同）
  const pcm = info.raw.subarray(info.dataOffset, info.dataOffset + info.dataSize);
  const mine = voiceover.buildAppleWav(pcm, info.rate, info.channels, info.bits);
  const a = info.raw.subarray(0, 4096);
  const b = mine.subarray(0, 4096);
  const diffs = [];
  for (let i = 0; i < 4096; i++) if (a[i] !== b[i]) diffs.push(i);
  const onlyLengths = diffs.every((i) => i >= 4 && i < 8) && diffs.length <= 4;
  check(
    '重新封装后头部与 Apple 一致（仅长度字段不同）',
    diffs.length === 0 || onlyLengths,
    diffs.length ? `差异字节：${diffs.slice(0, 12).join(',')}` : '',
  );
  check('PCM 数据逐字节一致', eqBuf(pcm, mine.subarray(4096)));
  check(`采样率 ${info.rate} Hz`, info.rate === 22050, `实际 ${info.rate}`);
}

// ============================================================ T4 元数据解析

section('T4  MP3 元数据解析（对照 Apple 写入数据库的真实值）');

/** 来自对设备 iTunesSD 的实测：文件 → { stopMs, numsamples, audioBytes } */
const EXPECTED = {
  'SBJT.mp3': { stop: 1496816, ns: 66008292, ab: 23945718, sr: 44100 },
  'DQNL.mp3': { stop: 1587957, ns: 70027860, ab: 25403977, sr: 44100 },
  'OOFR.mp3': { stop: 1603578, ns: 70716408, ab: 25653917, sr: 44100 },
  'VQCA.mp3': { stop: 2082403, ns: 91832664, ab: 33315109, sr: 44100 },
  'DQMD.mp3': { stop: 1926347, ns: 42474446, ab: 15409110, sr: 22050 },
  'NEPE.mp3': { stop: 1988571, ns: 43843504, ab: 9941812, sr: 22050 },
  'YTKZ.mp3': { stop: 2069968, ns: 45641758, ab: 10348800, sr: 22050 },
  'WBSM.mp3': { stop: 1876088, ns: 82733952, ab: 30014067, sr: 44100 },
  'AWWS.mp3': { stop: 1850906, ns: 81623808, ab: 29611154, sr: 44100 },
  'CGMU.mp3': { stop: 1934106, ns: 85292928, ab: 30942354, sr: 44100 },
  'INUQ.mp3': { stop: 1817208, ns: 80137344, ab: 29071987, sr: 44100 },
  'GAKR.mp3': { stop: 1803885, ns: 79547580, ab: 28858826, sr: 44100 },
  'IEWX.mp3': { stop: 1831444, ns: 80765328, ab: 18312359, sr: 44100 },
};

if (!ipodRoot) {
  skipSection('T4', '未检测到 iPod，无法读取真实 MP3');
} else {
  // 期望值有两个来源：
  //   1) 下面的实测表 —— 那 13 首原始曲目的数字是逐个钉死的，最严格；
  //   2) 表里没有的文件 → 回落到**设备当前数据库自己记录的数值**。
  // 同样出自 Apple 之手，只是不再依赖"原始那 13 首还没被删掉"（本工具就是
  // 用来删它们的，钉死在它们身上等于测试早晚会自己失效）。
  const sdModel = device.loadLibrary(ipodRoot, false).model;
  const sdByPath = new Map();
  for (const t of sdModel.tracks) {
    if (t.filename) sdByPath.set(t.filename.replace(/^\/+/, ''), t);
  }

  const files = device.scanMusicFiles(ipodRoot);
  let checked = 0;
  let durOk = 0;
  let abOk = 0;
  let srOk = 0;
  let fromTable = 0;
  for (const [rel, meta] of files) {
    const name = path.basename(rel);
    const pinned = EXPECTED[name];
    const sd = sdByPath.get(rel);
    // sd.sampleRate 数据库里没有，用 null 表示"不作采样率断言"
    const exp = pinned ?? (sd ? { stop: sd.stopMs, ab: sd.audioBytes, sr: null } : null);
    if (!exp) continue;
    checked++;
    if (pinned) fromTable++;
    let info;
    try {
      info = audio.probeAudioFile(meta.absPath);
    } catch (e) {
      console.log(`      解析失败 ${name}: ${e.message}`);
      continue;
    }
    const durDeltaMs = Math.abs(info.durationMs - exp.stop);
    // 实测 Apple 的 stopMs = round(帧字节和 × 8 ÷ 码率 × 1000)，允许 1ms 舍入差
    if (durDeltaMs <= 1) durOk++;
    else console.log(`      ${name}: 时长 ${info.durationMs} vs Apple ${exp.stop}（差 ${durDeltaMs}ms）`);

    // 实测 Apple 的 0x130 = 帧字节和 − 最后 8 帧，要求精确相等
    if (info.audioBytes === exp.ab) abOk++;
    else console.log(`      ${name}: 音频流 ${info.audioBytes} vs Apple ${exp.ab}（差 ${info.audioBytes - exp.ab}）`);

    if (exp.sr === null || info.sampleRate === exp.sr) srOk++;
    else console.log(`      ${name}: 采样率 ${info.sampleRate} vs 期望 ${exp.sr}`);
  }
  mark(`其中 ${fromTable} 个对照实测表，${checked - fromTable} 个对照设备当前数据库`);
  check(`抽查 ${checked} 个文件时长与 Apple 完全一致（±1ms）`, checked > 0 && durOk === checked, `${durOk}/${checked}`);
  check(`0x130 字段与 Apple 精确一致（帧和 − 最后 8 帧）`, abOk === checked, `${abOk}/${checked}`);
  check(`采样率识别正确`, srOk === checked, `${srOk}/${checked}`);
}

// ============================================================ T5 iTunesDB 标题

section('T5  iTunesDB 标题回退');

if (!ipodRoot) {
  skipSection('T5', '未检测到 iPod');
} else {
  const db = itunesdb.readItunesDb(ipodRoot);
  check('iTunesDB 解析出条目', db.size > 0, `${db.size} 条`);
  const withTitle = [...db.values()].filter((v) => v.title).length;
  check('至少解析出 1 个标题', withTitle > 0, `${withTitle} 条有标题`);
  const sample = [...db.entries()].find(([, v]) => v.title);
  if (sample) console.log(`      样例：${sample[0]} → 「${sample[1].title}」`);
}

// ============================================================ 汇总

function summary() {
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`通过 ${pass} · 失败 ${fail} · 跳过 ${skip} 组`);
  if (fail) {
    console.log(`\n失败项：`);
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log('═'.repeat(64));
  process.exit(fail ? 1 : 0);
}

// ============================================================ T6 端到端同步

/**
 * 需要真机的测试组（T6/T7）。没有设备时整体跳过，
 * 但不会中断后面的 T8 —— T8 用合成音频，任何环境都能跑。
 */
async function runHardwareSuites() {
  section('T6  端到端同步（在临时仿真设备上增删，不触碰真机）');
  if (!ipodRoot) {
    skipSection('T6', '未接入真机，没有可复制的真实 MP3');
    skipSection('T7', '未接入真机，无法校验语音全链路');
    return;
  }
  const { syncDevice } = core('sync');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ipod-e2e-'));

  // 素材取自**真机当前实际内容**，而不是归档的原始数据库。
  // 原因：归档里那几首原始曲目，正是本工具被拿来删掉的对象 —— 删了就找不回来了，
  // 测试会莫名为"文件不存在"而挂掉（2026-09-15 实际发生过）。
  // 改用"设备上现在真实存在的文件"当种子，并**留至少 1 个文件**作为"新增源"。
  const rel = (t) => t.filename.replace(/^\/+/, '');
  const realModel = itunessd.parseSd(
    fs.readFileSync(path.join(ipodRoot, 'iPod_Control/iTunes/iTunesSD')),
  );
  const present = realModel.tracks
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.filename && fs.existsSync(path.join(ipodRoot, rel(t))));

  if (present.length < 2) {
    skipSection(
      'T6',
      `真机上只有 ${present.length} 个可用音频文件，至少需要 2 个（1 个当种子 + 1 个当新增源）`,
    );
    skipSection('T7', '依赖 T6 造出的仿真设备');
    return;
  }

  const seedCount = Math.min(3, present.length - 1);
  const keep = present.slice(0, seedCount).map((x) => x.i).map((i) => realModel.tracks[i]);
  mark(`种子来自真机当前内容：${keep.map((t) => rel(t)).join('、')}`);

  fs.mkdirSync(path.join(fixture, 'iPod_Control/iTunes'), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'iPod_Control/Speakable/Tracks'), { recursive: true });
  fs.writeFileSync(
    path.join(fixture, 'iPod_Control/iTunes/iTunesSD'),
    itunessd.buildSd(itunessd.withTracks(realModel, keep)),
  );
  for (const t of keep) {
    // 真实曲目可能分布在 F00/F01/F02，父目录要按实际路径建
    const dest = path.join(fixture, rel(t));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(ipodRoot, rel(t)), dest);
  }

  (async () => {
    const before = device.loadLibrary(fixture, true);
    check(
      `仿真设备初始 ${seedCount} 首`,
      before.tracks.length === seedCount && before.missingFiles === 0,
      `${before.tracks.length} 首`,
    );

    // 找一个真机上不在初始集合里的文件作为新增源
    const all = [...device.scanMusicFiles(ipodRoot).entries()];
    const used = new Set(keep.map((t) => rel(t)));
    const addition = all.find(([r]) => !used.has(r));
    check('找到可用于新增的真实 MP3', !!addition, addition?.[0]);

    // 要移除的是"种子里最后一首"，不写死下标 —— 种子数量会随真机内容变化
    const removeTarget = before.tracks[before.tracks.length - 1];

    const res = await syncDevice(fixture, path.join(fixture, 'backups'), {
      addSources: addition ? [addition[1].absPath] : [],
      removeIds: [removeTarget.id],
      generateVoiceover: false,
      skipDuplicates: false,
    });

    check('新增 1 首', res.added === 1, `实际 ${res.added}`);
    check('移除 1 首', res.removed === 1, `实际 ${res.removed}`);
    check('生成了数据库备份', !!res.backupPath, res.backupPath);

    const after = device.loadLibrary(fixture, true);
    check(
      `最终曲目数 = ${seedCount}（+1 新增 −1 移除）`,
      after.tracks.length === seedCount,
      `实际 ${after.tracks.length}`,
    );
    check('没有幽灵条目（数据库与文件一一对应）', after.missingFiles === 0, `缺失 ${after.missingFiles}`);
    check('没有孤儿文件', after.orphanFiles === 0, `孤儿 ${after.orphanFiles}`);
    check(
      '被移除的曲目确实不在列表里',
      !after.tracks.some((t) => t.id === removeTarget.id),
    );

    const roundtrip = itunessd.buildSd(after.model);
    const onDisk = fs.readFileSync(path.join(fixture, 'iPod_Control/iTunes/iTunesSD'));
    check('写入后的数据库仍可往返', eqBuf(roundtrip, onDisk));

    const newTrack = after.model.tracks[after.model.tracks.length - 1];
    check('新增曲目的 filename 带前导 /', newTrack.filename.startsWith('/'), newTrack.filename);
    check('新增曲目的 filetype = 1 (MP3)', newTrack.filetype === 1, String(newTrack.filetype));
    check('新增曲目的 pregap = 528', newTrack.pregap === 528, String(newTrack.pregap));
    check('新增曲目的 stopMs > 0', newTrack.stopMs > 0, String(newTrack.stopMs));
    // 采样率不能写死成 44100：新增源是哪首歌取决于真机上现在有什么，
    // 实测素材里 44.1kHz 与 22.05kHz 两类都存在，写死会误报。
    if (addition) {
      const srcInfo = audio.probeAudioFile(addition[1].absPath);
      const expectNs = (newTrack.stopMs / 1000) * srcInfo.sampleRate;
      check(
        `新增曲目的 numsamples ≈ 时长 × 采样率（源为 ${srcInfo.sampleRate} Hz）`,
        Math.abs(newTrack.numsamples - expectNs) / newTrack.numsamples < 0.001,
        `${newTrack.numsamples} vs ${Math.round(expectNs)}`,
      );
    }
    check('新增曲目的 audioBytes > 0', newTrack.audioBytes > 0, String(newTrack.audioBytes));

    console.log(`\n  仿真设备目录：${fixture}`);
    console.log(`  最终曲目：`);
    for (const t of after.tracks) {
      console.log(`    ${t.format}  ${String(Math.round(t.durationMs / 1000)).padStart(5)}s  ${t.title}`);
    }

    // ============================================================ T7
    section('T7  VoiceOver 全链路（合成 → Apple 容器 → 写入设备目录 → 幂等）');

    const diag = voiceover.ttsDiagnostics();
    console.log(`  后端     : ${diag.backend ?? '（无）'}`);
    console.log(`  PowerShell: ${diag.powershellFound ? diag.powershell : '不可用'}`);
    console.log(`  Python   : ${diag.python ?? '（未使用）'}`);
    if (diag.error) console.log(`  诊断     : ${diag.error}`);
    console.log(`  语音     : ${diag.voices.map((v) => v.name).join(' / ') || '（无）'}`);

    check('存在可用的语音合成后端', !!diag.backend, diag.error || '');
    check(
      '枚举到中文语音',
      diag.voices.some((v) => /huihui|chinese|zh/i.test(v.name + v.culture)),
      diag.voices.map((v) => v.name).join(),
    );

    if (diag.backend) {
      const need = after.model.tracks.length;
      const t0 = Date.now();
      const res2 = await syncDevice(fixture, path.join(fixture, 'backups'), {
        addSources: [],
        removeIds: [],
        generateVoiceover: true,
        enableVoiceover: true,
      });
      const elapsed = Date.now() - t0;

      check(`为全部 ${need} 首生成语音`, res2.voiceoverCreated === need, `实际 ${res2.voiceoverCreated}`);
      check('VoiceOver 总开关为开', device.loadLibrary(fixture, false).model.root.voiceover === 1);

      const tracksDir = path.join(fixture, 'iPod_Control/Speakable/Tracks');
      const made = fs.readdirSync(tracksDir).filter((f) => f.endsWith('.wav'));
      check('语音文件数量正确', made.length === need, `实际 ${made.length}`);

      let named = 0;
      let container = 0;
      let pcmOk = 0;
      for (const t of after.model.tracks) {
        const want = voiceover.voiceFilename(t.dbid);
        if (made.includes(want)) named++;
        const info = voiceover.parseWav(path.join(tracksDir, want));
        if (info && info.dataOffset === 4096) container++;
        if (info && info.pcm && info.channels === 1 && info.bits === 16 && info.rate === 22050) pcmOk++;
      }
      check('文件名 = dbid 倒序十六进制，全部命中', named === need, `${named}/${need}`);
      check('全部为 Apple 4096 字节容器', container === need, `${container}/${need}`);
      check('全部为 22050Hz 单声道 16 位 PCM', pcmOk === need, `${pcmOk}/${need}`);

      mark(`合成耗时 ${elapsed} ms（约 ${Math.round(elapsed / need)} ms/条）`);

      // 幂等：语音已存在时必须跳过，不做无用合成
      const res3 = await syncDevice(fixture, path.join(fixture, 'backups'), {
        addSources: [],
        removeIds: [],
        generateVoiceover: true,
      });
      check(
        '重复同步时语音被跳过（幂等）',
        res3.voiceoverCreated === 0 && res3.voiceoverSkipped === need,
        `新建 ${res3.voiceoverCreated} / 跳过 ${res3.voiceoverSkipped}`,
      );
    }

    fs.rmSync(fixture, { recursive: true, force: true });
  })();
}

// ============================================================ T8 一致性收敛

/**
 * 造一段合法的 MPEG-1 Layer III 帧序列，确定性、不依赖任何真实音频文件。
 * 帧头 0xFFFB = MPEG1 / Layer III / 无 CRC；0x90 = 128kbps / 44100Hz / 无填充。
 * 帧长 = floor(1152 ÷ 8 × 128000 ÷ 44100) = 417 字节，正好喂给 parseMp3 的帧走查。
 */
function synthMp3(frameCount) {
  const FRAME = 417;
  const buf = Buffer.alloc(FRAME * frameCount);
  for (let f = 0; f < frameCount; f++) {
    const o = f * FRAME;
    buf[o] = 0xff;
    buf[o + 1] = 0xfb;
    buf[o + 2] = 0x90;
    buf[o + 3] = 0x00;
  }
  return buf;
}

/**
 * 一致性收敛：同步结束后，**数据库登记集合必须等于 Music/ 里的真实文件集合**。
 *
 * 两个方向都要收敛，缺一个就留垃圾：
 *   1) 有记录没文件（用户在资源管理器里直接删了）→ 记录必须被清除
 *   2) 有文件没记录（复制中断留下的残渣）        → 文件必须被删除
 * 另外验两条安全边界：数据库为空时放弃清理（绝不误删整库）、
 * pruneOrphans=false 时一个字节都不动。
 */
async function runConsistency() {
  section('T8  一致性收敛（数据库登记 ≡ Music/ 实际文件）');

  const { syncDevice } = core('sync');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ipod-consist-'));
  const F00 = path.join(fixture, 'iPod_Control/Music/F00');
  const TRACKS = path.join(fixture, 'iPod_Control/Speakable/Tracks');
  const SD = path.join(fixture, 'iPod_Control/iTunes/iTunesSD');
  fs.mkdirSync(path.dirname(SD), { recursive: true });
  fs.mkdirSync(F00, { recursive: true });
  fs.mkdirSync(TRACKS, { recursive: true });

  // 借 Apple 原始数据库的前 3 条真实记录当模板（含真实 dbid），音频换成合成帧
  // —— 于是本测试不需要真机，任何环境都能跑。
  const model = itunessd.parseSd(fs.readFileSync(ORIGINAL_SD));
  const kept = model.tracks.slice(0, 3);
  fs.writeFileSync(SD, itunessd.buildSd(itunessd.withTracks(model, kept)));

  for (const t of kept) {
    const abs = path.join(fixture, t.filename.replace(/^\/+/, ''));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, synthMp3(200));
    // 每首歌配一个语音文件（内容无关紧要，只验「该留的留住」）
    fs.writeFileSync(path.join(TRACKS, voiceover.voiceFilename(t.dbid)), Buffer.alloc(64, 0));
  }

  const base = device.loadLibrary(fixture, false);
  check(
    '仿真设备就绪：3 首、无幽灵、无孤儿',
    base.tracks.length === 3 && base.missingFiles === 0 && base.orphanFiles === 0,
    `${base.tracks.length} 首 / 缺 ${base.missingFiles} / 孤儿 ${base.orphanFiles}`,
  );

  // ---- 制造三种不一致 ----------------------------------------------------
  const victimAbs = path.join(fixture, kept[0].filename.replace(/^\/+/, ''));
  fs.rmSync(victimAbs);                                    // a) 文件被直接删掉
  const strayAudio = path.join(F00, 'ZZZZ.mp3');
  fs.writeFileSync(strayAudio, synthMp3(20));              // b) 数据库不知道的音频
  const strayVoice = path.join(TRACKS, 'AAAABBBBCCCCDDDD.wav');
  fs.writeFileSync(strayVoice, Buffer.alloc(64, 0));       // c) 无主语音

  const dirty = device.loadLibrary(fixture, false);
  check('已制造出 1 条幽灵记录', dirty.missingFiles === 1, `实际 ${dirty.missingFiles}`);
  check('已制造出 1 个孤儿音频', dirty.orphanFiles === 1, `实际 ${dirty.orphanFiles}`);

  // ---- 同步：两个方向同时收敛 --------------------------------------------
  const r = await syncDevice(fixture, path.join(fixture, 'backups'), {
    addSources: [],
    removeIds: [],
    generateVoiceover: false,
  });

  check('文件被删 → 对应记录被清除', r.ghostPruned === 1, `实际 ${r.ghostPruned}`);
  check('未登记音频被删除', r.orphanRemoved === 1, `实际 ${r.orphanRemoved}`);
  check(
    '无主语音被删除（含刚清掉那首留下的语音）',
    r.orphanVoiceRemoved === 2,
    `实际 ${r.orphanVoiceRemoved}`,
  );
  check('无清理失败', r.orphanKept === 0, `实际 ${r.orphanKept}`);

  const tidy = device.loadLibrary(fixture, false);
  check('曲目数 3 → 2', tidy.model.tracks.length === 2, `实际 ${tidy.model.tracks.length}`);
  check('收敛后无幽灵记录', tidy.missingFiles === 0, `实际 ${tidy.missingFiles}`);
  check('收敛后无孤儿文件', tidy.orphanFiles === 0, `实际 ${tidy.orphanFiles}`);
  check('未登记音频确实已从磁盘消失', !fs.existsSync(strayAudio));
  check('无主语音确实已从磁盘消失', !fs.existsSync(strayVoice));
  check(
    '存活曲目的语音文件被保留',
    tidy.tracks.every((t) =>
      fs.existsSync(path.join(TRACKS, voiceover.voiceFilename(Buffer.from(t.id, 'hex')))),
    ),
  );
  check('写入后的数据库仍可逐字节往返', eqBuf(itunessd.buildSd(tidy.model), fs.readFileSync(SD)));

  // ---- 安全边界一：数据库为空时绝不能清空整个 Music/ ----------------------
  const stranded = device.scanMusicFiles(fixture).size;
  fs.writeFileSync(SD, itunessd.buildSd(itunessd.withTracks(tidy.model, [])));
  const r2 = await syncDevice(fixture, path.join(fixture, 'backups'), {
    addSources: [],
    removeIds: [],
    generateVoiceover: false,
  });
  check(
    '数据库为空 → 放弃清理（不误删整库）',
    r2.orphanRemoved === 0 && r2.orphanVoiceRemoved === 0,
    `音频 ${r2.orphanRemoved} / 语音 ${r2.orphanVoiceRemoved}`,
  );
  check('并给出明确警告', r2.warnings.some((w) => w.includes('数据库当前为空')), r2.warnings.join(' | '));
  check(
    'Music/ 下的文件一个都没少',
    device.scanMusicFiles(fixture).size === stranded && stranded > 0,
    `${device.scanMusicFiles(fixture).size} / 原 ${stranded}`,
  );

  // ---- 安全边界二：显式关闭清理时一个字节都不动 --------------------------
  const stray2 = path.join(F00, 'YYYY.mp3');
  fs.writeFileSync(stray2, synthMp3(20));
  const before3 = device.scanMusicFiles(fixture).size;
  const r3 = await syncDevice(fixture, path.join(fixture, 'backups'), {
    addSources: [],
    removeIds: [],
    generateVoiceover: false,
    pruneOrphans: false,
  });
  check(
    'pruneOrphans=false → 不做任何清理',
    r3.orphanRemoved === 0 &&
      r3.orphanVoiceRemoved === 0 &&
      !r3.warnings.some((w) => w.includes('跳过孤儿')),
    `音频 ${r3.orphanRemoved} / 语音 ${r3.orphanVoiceRemoved}`,
  );
  check(
    '且新塞进去的孤儿文件原封不动',
    fs.existsSync(stray2) && device.scanMusicFiles(fixture).size === before3,
  );

  fs.rmSync(fixture, { recursive: true, force: true });
}

// ============================================================ T9 VoiceOver 合成

/**
 * 写入设备前，VoiceOver 由 `synthesize()` 合成、包成 Apple 容器后落到
 * `Speakable/Tracks/`。这里验证**要写进设备的那份数据本身**：
 * 播报文本怎么拼、容器头是否合规、同一文本重复合成是否稳定。
 *
 * 不依赖真机。
 */
async function runVoiceoverSynth() {
  section('T9  VoiceOver 合成（Apple 容器）');

  const backend = voiceover.resolveBackend();
  if (!backend) {
    // 语音合成是核心功能：后端不可用时新增曲目**不会播报**，而且写入流程不会中断
    // （错误只进 warnings），用户往往是"上了机器才发现不播报"。
    // 所以这里必须报失败 —— 早先这里是 skipSection，测试常年全绿，
    // 功能坏了却没人知道（本机就踩过：PowerShell 被策略拦截、系统 Python 又没 pywin32）。
    const diag = voiceover.ttsDiagnostics();
    check(
      '存在可用的语音合成后端（否则新增曲目不会播报）',
      false,
      `${diag.error || '未检测到 PowerShell 或带 pywin32 的 Python'}\n` +
        '      修法：在任一 Python 环境执行  pip install pywin32 ，' +
        '或设置 SHUFFLEMATE_PYTHON 指向可用的 python.exe 后重跑。',
    );
    return;
  }
  mark(`后端：${backend.name}`);

  const title = '2009年06月六级听力真题';

  // ---- 播报文本的拼装规则（写入设备时用的就是这个函数）------------------
  check('announceText(标题) 即标题本身', voiceover.announceText(title) === title);
  check(
    'announceText(标题, 艺术家) 以 " - " 连接',
    voiceover.announceText(title, '周杰伦') === `${title} - 周杰伦`,
    voiceover.announceText(title, '周杰伦'),
  );
  check('艺术家为空白时不留下多余的连字符', voiceover.announceText(title, '   ') === title);

  // ---- 合成产物是 Apple 容器 --------------------------------------------
  const { data: apple, info: appleInfo } = await voiceover.synthesize(title);

  check('合成产物是 Apple 容器', appleInfo.isAppleContainer === true, `dataOffset=${appleInfo.dataOffset}`);
  check('头部恰为 4096 字节', appleInfo.dataOffset === voiceover.APPLE_HEADER_LEN);
  check(
    `格式 ${voiceover.DEFAULT_RATE}Hz 单声道 16bit PCM`,
    appleInfo.rate === voiceover.DEFAULT_RATE &&
      appleInfo.channels === 1 &&
      appleInfo.bits === 16 &&
      appleInfo.pcm,
    `${appleInfo.rate}Hz ${appleInfo.channels}ch ${appleInfo.bits}bit pcm=${appleInfo.pcm}`,
  );
  check('含 FLLR 填充块', apple.subarray(0x24, 0x28).toString('latin1') === 'FLLR');
  check('音频时长 > 0', appleInfo.duration > 0, `${appleInfo.duration.toFixed(2)}s`);
  mark(`「${title}」→ ${appleInfo.duration.toFixed(2)}s · ${appleInfo.dataSize} 字节 PCM`);

  // ---- 重复合成应当稳定（写入时靠它判定"已有语音、无需重做"）------------
  const applePcm = apple.subarray(appleInfo.dataOffset, appleInfo.dataOffset + appleInfo.dataSize);
  const again = await voiceover.synthesize(title);
  check(
    '同一文本重复合成，PCM 长度稳定',
    again.info.dataSize === appleInfo.dataSize,
    `${again.info.dataSize} vs ${appleInfo.dataSize}`,
  );
  const againPcm = again.data.subarray(
    again.info.dataOffset,
    again.info.dataOffset + again.info.dataSize,
  );
  mark(`重复合成内容 ${againPcm.equals(applePcm) ? '完全一致' : '有差异（缓存仍按文本命中，不影响正确性）'}`);
}

// ============================================================ T10 热插拔去抖

/**
 * `StableDetector` 决定"设备到底算不算插着"。它错一次的代价是界面闪一下
 * "设备已断开"，或者明明拔了却还显示着设备 —— 正是要修的那个问题。
 *
 * 这里用任意观测序列直接喂它，不需要真机、也不需要真的等秒数。
 */
function runHotplugDebounce() {
  section('T10  设备热插拔去抖（连续观测确认）');

  // ---- 正常插入：一次观测不算数，连续两次才认 ----
  let d = new hotplug.StableDetector(null, 2);
  check('起始无设备时 value 为 null', d.value === null);
  let r = d.observe('F:/');
  check('只观测到 1 次不认账（避免挂载瞬间误报）', r.changed === false);
  check('未认账时仍报告旧状态', r.root === null);
  r = d.observe('F:/');
  check('★ 连续 2 次观测到同一设备 → 确认插入', r.changed === true && r.root === 'F:/');
  check('确认后 value 同步更新', d.value === 'F:/');
  r = d.observe('F:/');
  check('状态稳定后不再重复报告变化', r.changed === false);

  // ---- 正常拔出 ----
  r = d.observe(null);
  check('拔出同样需要 2 次确认', r.changed === false);
  r = d.observe(null);
  check('★ 连续 2 次观测不到设备 → 确认拔出', r.changed === true && r.root === null);

  // ---- 关键：瞬时读失败不得被当成拔出 ----
  d = new hotplug.StableDetector('F:/', 2);
  d.observe(null); // 某一次 existsSync 失败
  r = d.observe('F:/'); // 下一次又读到了
  check(
    '★ 瞬时读失败后恢复（null → F:/）不产生任何变化事件',
    r.changed === false && r.root === 'F:/',
    `changed=${r.changed} root=${r.root}`,
  );
  r = d.observe(null);
  check('抖动后计数被清零，需重新累计 2 次', r.changed === false);
  r = d.observe(null);
  check('真正的拔出仍能被识别', r.changed === true && r.root === null);

  // ---- 候选状态被别的值打断时，计数要重新来 ----
  d = new hotplug.StableDetector(null, 2);
  d.observe('F:/');
  d.observe('G:/'); // 换了一台设备，上一个候选作废
  r = d.observe('G:/');
  check('候选被打断后需重新累计，但最终仍能确认', r.changed === true && r.root === 'G:/');

  // ---- 启动时设备本来就插着：不应被当成一次"插入" ----
  d = new hotplug.StableDetector('F:/', 2);
  r = d.observe('F:/');
  check('以实际状态为初值 → 启动时不误报插入', r.changed === false);

  // ---- confirmTicks=1：立即确认（供需要零延迟时使用）----
  d = new hotplug.StableDetector(null, 1);
  r = d.observe('F:/');
  check('confirmTicks=1 时单次观测即确认', r.changed === true && r.root === 'F:/');

  // ---- confirmTicks 下限保护 ----
  d = new hotplug.StableDetector(null, 0);
  r = d.observe('F:/');
  check('confirmTicks=0 被夹到 1：首次观测即确认，不会永不确认', r.changed === true && r.root === 'F:/');
}

(async () => {
  await runHardwareSuites();
  await runConsistency();
  await runVoiceoverSynth();
  runHotplugDebounce();
  summary();
})().catch((e) => {
  console.error('\n测试异常：', e);
  process.exit(1);
});
