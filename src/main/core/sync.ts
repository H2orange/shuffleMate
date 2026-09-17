/**
 * 同步：把「本地待导入 + 勾选删除」变成设备上的最终状态。
 *
 * 核心架构决策 —— **不做增量二进制补丁，每次整体重建 iTunesSD**：
 *  - 设备上的 `iPod_Control/Music/` 是唯一真相来源；
 *  - 存量曲目**按路径沿用设备原记录**（保留 Apple 计算的精确字段与 dbid，
 *    因此它们原有的 VoiceOver 语音文件继续有效、零成本）；
 *  - 只有真正新增的文件才由我们生成记录，风险被隔离在新增项内。
 *
 * 执行顺序（顺序本身就是安全设计）：
 *   1) 复制新增文件 → 2) 写数据库 → 3) 删除被移除的文件 → 4) 生成语音 → 5) 刷盘
 * 这样任一步失败，设备最坏也只是多出几个「孤儿文件」（下次同步自动清理），
 * 而不会出现「数据库里有一条、文件却不存在」的幽灵条目。
 *
 * **不变式：同步结束后，数据库登记集合 ≡ Music/ 下真实存在的文件集合。**
 * 两个方向都要收敛，缺一个就会留下垃圾：
 *  - 有记录、没文件 → 清掉记录（ghostPruned），否则设备上出现点不响的幽灵曲目
 *  - 有文件、没记录 → 删掉文件（orphanRemoved），否则白占空间且谁也播不到
 * 其中「删文件」是不可逆的破坏性操作，所以先做数据库完整性自检（见 roundTrips），
 * 自检不过就整体放弃清理 —— 宁可留下垃圾，也不能误删整库。
 */
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_PREGAP, probeAudioFile, UnsupportedFormatError } from './audio';
import { loadLibrary, readTrackMeta, writeTrackMeta } from './device';
import {
  atomicWriteFile,
  backupFile,
  copyFileSync,
  ensureDir,
  exists,
  flushVolume,
  removeFileSafe,
  toPosix,
} from './fsx';
import { buildSd, makeTrackRecord, parseSd, withTracks } from './itunessd';
import { SyncResult, TrackRecord, TrackView } from './types';
import {
  DEFAULT_RATE,
  announceText,
  dbidFromText,
  detectSpeakableFormat,
  speakableDirs,
  synthesize,
  voiceFilename,
} from './voiceover';

const MUSIC_REL = 'iPod_Control/Music';
const SD_REL = 'iPod_Control/iTunes/iTunesSD';
/** Apple 每个文件夹的曲目上限（超过则开新文件夹） */
const FOLDER_CAPACITY = 40;
/** 单条语音的容量预估，用于导入前的空间预检（实测约 100~180 KB） */
const VOICEOVER_ESTIMATE = 200 * 1024;

export interface SyncProgress {
  phase: 'prepare' | 'copy' | 'database' | 'delete' | 'voiceover' | 'flush' | 'done';
  message: string;
  current: number;
  total: number;
}

export interface SyncOptions {
  /** 本地待导入文件（绝对路径） */
  addSources?: string[];
  /** 要移除的曲目 id（dbid 十六进制） */
  removeIds?: string[];
  /** 是否为缺失语音的曲目生成 VoiceOver */
  generateVoiceover?: boolean;
  /** 强制打开 VoiceOver 总开关（设备原本为关时） */
  enableVoiceover?: boolean;
  /** 语音采样率；null / undefined = 自动对齐设备现有文件 */
  voiceoverRate?: number | null;
  /** SAPI 语速 -10..10 */
  voiceoverSpeed?: number;
  /** 语音名称 */
  voiceoverVoice?: string | null;
  /** 全局音量增益 0..99（0 = 不改动） */
  volumeGain?: number;
  /** 跳过设备上已存在的同曲（标题 + 时长近似） */
  skipDuplicates?: boolean;
  /**
   * 清理孤儿文件（`Music/` 里存在、但数据库没有引用的音频，以及已无对应
   * 曲目的语音文件），默认开启 —— 目的是让「数据库记录」与「设备上实际歌曲」
   * 始终严格一致，不留幽灵条目、不占无用空间。传 false 可关闭。
   */
  pruneOrphans?: boolean;
  onProgress?: (p: SyncProgress) => void;
}

export class SpaceError extends Error {}

// ---------------------------------------------------------------- 目标路径分配

class PathAllocator {
  private counts = new Map<string, number>();
  private names = new Set<string>();

  constructor(existing: Iterable<string>) {
    for (const rel of existing) {
      const parts = rel.split('/');
      const folder = parts[parts.length - 2];
      const base = parts[parts.length - 1].replace(/\.[^.]+$/, '').toUpperCase();
      if (folder) this.counts.set(folder, (this.counts.get(folder) ?? 0) + 1);
      this.names.add(base);
    }
  }

  /** 选取最少占用的文件夹；满了就开新的（Apple 也用 F00..F49 这套编号） */
  private pickFolder(): string {
    if (this.counts.size === 0) {
      this.counts.set('F00', 0);
      return 'F00';
    }
    let best = '';
    let bestCount = Infinity;
    for (const [folder, n] of this.counts) {
      if (n < bestCount || (n === bestCount && folder < best)) {
        best = folder;
        bestCount = n;
      }
    }
    if (bestCount >= FOLDER_CAPACITY) {
      const used = [...this.counts.keys()]
        .map((f) => parseInt(f.replace(/^F/, ''), 10))
        .filter((n) => Number.isFinite(n));
      const next = (used.length ? Math.max(...used) : -1) + 1;
      if (next > 49) throw new SpaceError('设备上的 Music 文件夹已用尽（F00–F49）');
      const f = `F${String(next).padStart(2, '0')}`;
      this.counts.set(f, 0);
      return f;
    }
    return best;
  }

  /** 生成 4 位大写字母的随机文件名（与 Apple 的命名风格一致，且保证不冲突） */
  private randomName(): string {
    for (let attempt = 0; attempt < 10_000; attempt++) {
      let s = '';
      for (let i = 0; i < 4; i++) {
        s += String.fromCharCode(65 + Math.floor(Math.random() * 26));
      }
      if (!this.names.has(s)) {
        this.names.add(s);
        return s;
      }
    }
    throw new Error('无法分配唯一的文件名');
  }

  /** 分配目标路径，返回相对于 iPod 根、**带前导 `/`** 的设备路径（直接写入数据库） */
  next(ext: string): { devicePath: string; absPath: string } {
    const folder = this.pickFolder();
    const name = `${this.randomName()}${ext.startsWith('.') ? ext : `.${ext}`}`;
    this.counts.set(folder, (this.counts.get(folder) ?? 0) + 1);
    const devicePath = `/${MUSIC_REL}/${folder}/${name}`;
    return { devicePath, absPath: devicePath.replace(/^\/+/, '') };
  }
}

// ---------------------------------------------------------------- 主流程

export async function syncDevice(
  root: string,
  backupsRoot: string,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const report = (phase: SyncProgress['phase'], message: string, current = 0, total = 0) =>
    opts.onProgress?.({ phase, message, current, total });

  const warnings: string[] = [];
  const result: SyncResult = {
    added: 0,
    removed: 0,
    voiceoverCreated: 0,
    voiceoverSkipped: 0,
    bytesWritten: 0,
    backupPath: null,
    ghostPruned: 0,
    orphanRemoved: 0,
    orphanVoiceRemoved: 0,
    orphanKept: 0,
    warnings,
  };

  report('prepare', '读取设备曲库…');
  const lib = loadLibrary(root, false);
  const removeIds = new Set(opts.removeIds ?? []);
  const sdPath = path.join(root, SD_REL);

  // 清理孤儿是一项**破坏性**操作，先给数据库做一次完整性自检：
  // 解析后原样重建必须能逐字节还原。如果还原不出来，说明我们的解析对这份
  // 数据库不完整（例如遇到了没见过的手册版本），此时「没被引用」这个判断
  // 本身就不可信 —— 宁可什么都不删。
  const dbIntact = roundTrips(sdPath);
  const pruneOrphans =
    opts.pruneOrphans !== false && dbIntact && lib.model.tracks.length > 0;
  if (opts.pruneOrphans !== false && !pruneOrphans) {
    warnings.push(
      dbIntact
        ? '数据库当前为空，已跳过孤儿文件清理（避免误删整库）。'
        : '数据库未能通过完整性自检，已跳过孤儿文件清理（无法确认哪些文件真的没被引用）。',
    );
  }

  // --- 1. 决定保留哪些曲目 -------------------------------------------------
  const kept: { rec: TrackRecord; view: TrackView }[] = [];
  for (let i = 0; i < lib.model.tracks.length; i++) {
    const view = lib.tracks[i];
    const rec = lib.model.tracks[i];
    if (removeIds.has(view.id)) continue;
    if (!view.exists) {
      // 数据库里有记录、文件却已不在（例如从资源管理器里直接删掉了）：
      // 顺手清掉这条幽灵记录，让数据库始终只登记真实存在的文件。
      result.ghostPruned++;
      warnings.push(`已清除失效记录：${view.title}（文件 ${view.filename} 已不存在）`);
      continue;
    }
    kept.push({ rec, view });
  }

  // --- 2. 解析新增文件 -----------------------------------------------------
  report('prepare', '解析待导入文件…');
  const sources = opts.addSources ?? [];
  const existingKeys = new Set(
    kept.map((k) => `${k.view.title.toLowerCase()}|${Math.round(k.view.durationMs / 1000)}`),
  );
  const pending: {
    info: Awaited<ReturnType<typeof probeAudioFile>>;
    src: string;
    devicePath: string;
    absPath: string;
    title: string;
  }[] = [];
  let needBytes = 0;

  for (const src of sources) {
    try {
      const info = probeAudioFile(src);
      const title = info.tag.title || path.basename(src).replace(/\.[^.]+$/, '');
      if (opts.skipDuplicates) {
        const key = `${title.toLowerCase()}|${Math.round(info.durationMs / 1000)}`;
        if (existingKeys.has(key)) {
          warnings.push(`已跳过疑似重复：${path.basename(src)}`);
          continue;
        }
      }
      needBytes += info.fileSize;
      pending.push({ info, src, devicePath: '', absPath: '', title });
      existingKeys.add(`${title.toLowerCase()}|${Math.round(info.durationMs / 1000)}`);
    } catch (e) {
      const msg =
        e instanceof UnsupportedFormatError
          ? e.message
          : `解析失败：${(e as Error).message}`;
      warnings.push(`已跳过 ${path.basename(src)} —— ${msg}`);
    }
  }

  // --- 3. 空间预检 ---------------------------------------------------------
  const voiceoverCount = opts.generateVoiceover ? kept.length + pending.length : 0;
  const reserve = voiceoverCount * VOICEOVER_ESTIMATE;
  let free = 0;
  try {
    const st = fs.statfsSync(root);
    free = st.bavail * st.bsize;
  } catch {
    /* 拿不到容量就不拦 */
  }
  if (free > 0 && needBytes + reserve > free) {
    const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
    throw new SpaceError(
      `设备空间不足：需要约 ${mb(needBytes + reserve)}（含语音预留），` +
        `可用 ${mb(free)}。请减少导入数量后重试。`,
    );
  }

  // --- 4. 分配目标路径并复制 -----------------------------------------------
  const allocator = new PathAllocator(lib.files.keys());
  const newRecords: TrackRecord[] = [];

  // 新曲目的分组 ID：有标签时按标签派生（保证同专辑/同艺术家一致），
  // 无标签时沿用设备上存量曲目的取值（Apple 在无标签时也是全部同桶）
  const templateAlbumId = mostCommon(lib.model.tracks.map((t) => t.albumid)) ?? 0;
  const templateArtistId = mostCommon(lib.model.tracks.map((t) => t.artistid)) ?? 0;

  if (pending.length > 0) report('copy', '复制音频文件…', 0, pending.length);

  for (let i = 0; i < pending.length; i++) {
    const p = pending[i];
    const ext = path.extname(p.src) || (p.info.container === 'm4a' ? '.m4a' : '.mp3');
    const dest = allocator.next(ext);
    p.devicePath = dest.devicePath;
    p.absPath = dest.absPath;

    const dstAbs = path.join(root, dest.absPath);
    const written = copyFileSync(p.src, dstAbs, (copied) =>
      report('copy', `复制 ${path.basename(p.src)}`, i + copied / Math.max(1, p.info.fileSize), pending.length),
    );
    result.bytesWritten += written;
    result.added++;

    const title = p.title;
    newRecords.push(
      makeTrackRecord({
        filename: dest.devicePath,
        filetype: p.info.filetype,
        durationMs: p.info.durationMs,
        sampleRate: p.info.sampleRate,
        audioBytes: p.info.audioBytes,
        dbid: dbidFromText(title),
        pregap: DEFAULT_PREGAP,
        albumid: p.info.tag.album
          ? stableId(p.info.tag.album, templateAlbumId)
          : templateAlbumId,
        artistid: p.info.tag.artist
          ? stableId(p.info.tag.artist, templateArtistId)
          : templateArtistId,
        trackNo: p.info.tag.trackNo ?? 0,
        disc: p.info.tag.discNo ?? 0,
        volumeGain: opts.volumeGain ?? 0,
      }),
    );
  }

  // --- 5. 重建并写入数据库 -------------------------------------------------
  const finalTracks = [...kept.map((k) => k.rec), ...newRecords];
  const titles = [...kept.map((k) => k.view.title), ...pending.map((p) => p.title)];
  const artists = [...kept.map((k) => k.view.artist), ...pending.map((p) => p.info.tag.artist ?? '')];

  report('database', '重建 iTunesSD…');
  const model = withTracks(lib.model, finalTracks);
  if (opts.enableVoiceover && model.root.voiceover === 0) {
    model.root.voiceover = 1;
    warnings.push('已打开设备数据库中的 VoiceOver 总开关（原本为关闭）。');
  }

  // 每次写入前备份
  if (exists(sdPath)) {
    try {
      result.backupPath = backupFile(sdPath, backupsRoot, 'prechange', 'iTunesSD');
    } catch (e) {
      warnings.push(`备份失败（仍继续）：${(e as Error).message}`);
    }
  }

  atomicWriteFile(sdPath, buildSd(model));

  // 回读校验：重建结果必须与刚写入的字节完全一致，否则立刻中止
  const verify = buildSd(loadLibrary(root, false).model);
  if (!verify.equals(fs.readFileSync(sdPath))) {
    throw new Error('数据库回读校验失败，已中止（设备上的 iTunesSD 可能不一致）。');
  }

  // --- 6. 删除被移除的文件（放在数据库写成功之后）--------------------------
  const removeList = lib.tracks.filter((t) => removeIds.has(t.id) && t.exists);
  if (removeList.length > 0) {
    report('delete', '删除已移除的曲目…', 0, removeList.length);
  }
  for (let i = 0; i < removeList.length; i++) {
    const t = removeList[i];
    const abs = path.join(root, t.filename);
    try {
      removeFileSafe(abs, path.join(root, MUSIC_REL));
      result.removed++;
      // 顺手删掉它的语音文件（该 dbid 不再使用）
      const voicePath = path.join(speakableDirs(root).tracks, voiceFilename(Buffer.from(t.id, 'hex')));
      if (exists(voicePath)) {
        try {
          removeFileSafe(voicePath, speakableDirs(root).tracks);
        } catch {
          /* 语音删除失败无害 */
        }
      }
    } catch (e) {
      warnings.push(`删除失败 ${t.filename}：${(e as Error).message}`);
    }
    report('delete', `删除 ${path.basename(t.filename)}`, i + 1, removeList.length);
  }

  // --- 6b. 清理孤儿：让「数据库登记」与「设备上真实存在的文件」严格一致 ----
  //   · 有记录、没文件 → 第 1 步已清除记录（ghostPruned）
  //   · 有文件、没记录 → 此处删除文件（orphanRemoved / orphanVoiceRemoved）
  // 放在数据库写成功之后执行：万一写入失败会先抛错，孤儿文件留到下次再清，
  // 不会出现「文件删了但库里还留着记录」这种更糟的中间态。
  if (pruneOrphans) {
    const { tracks: tracksDir } = speakableDirs(root);
    const refRel = new Set(finalTracks.map((t) => t.filename.replace(/^\/+/, '')));
    const refVoice = new Set(finalTracks.map((t) => voiceFilename(t.dbid).toLowerCase()));

    const orphanAudio = [...lib.files.keys()].filter((rel) => !refRel.has(rel));
    let orphanVoice: string[] = [];
    try {
      // 只认 Apple 的语音命名（16 位十六进制 + .wav），不碰目录里的任何其他东西
      orphanVoice = fs
        .readdirSync(tracksDir)
        .filter((f) => /^[0-9A-Fa-f]{16}\.wav$/.test(f) && !refVoice.has(f.toLowerCase()));
    } catch {
      /* Speakable/Tracks 不存在 → 没有语音可清 */
    }

    const total = orphanAudio.length + orphanVoice.length;
    if (total > 0) report('delete', '清理未登记的文件…', 0, total);

    const musicRoot = path.join(root, MUSIC_REL);
    const removedAudio: string[] = [];
    const removedVoice: string[] = [];
    const failed: string[] = [];
    let done = 0;

    for (const rel of orphanAudio) {
      try {
        removeFileSafe(path.join(root, rel), musicRoot);
        result.orphanRemoved++;
        removedAudio.push(rel);
      } catch (e) {
        result.orphanKept++;
        failed.push(`清理失败 ${rel}：${(e as Error).message}`);
      }
      report('delete', `清理 ${path.basename(rel)}`, ++done, total);
    }
    for (const f of orphanVoice) {
      try {
        removeFileSafe(path.join(tracksDir, f), tracksDir);
        result.orphanVoiceRemoved++;
        removedVoice.push(f);
      } catch (e) {
        result.orphanKept++;
        failed.push(`清理失败 ${f}：${(e as Error).message}`);
      }
      report('delete', `清理语音 ${f}`, ++done, total);
    }

    const summarize = (label: string, names: string[]) => {
      if (names.length === 0) return;
      const head = names.slice(0, 20).join('、');
      warnings.push(
        `${label} ${names.length} 个：${head}${names.length > 20 ? ` …等共 ${names.length} 个` : ''}`,
      );
    };
    summarize('已删除未登记音频（数据库未引用，设备本来也播不到）', removedAudio);
    summarize('已删除无主语音文件', removedVoice);
    failed.forEach((f) => warnings.push(f));
  }

  // --- 7. VoiceOver --------------------------------------------------------
  if (opts.generateVoiceover) {
    const { tracks: tracksDir, playlists } = speakableDirs(root);
    ensureDir(tracksDir);
    ensureDir(playlists);

    // 采样率对齐设备上 Apple 现有文件，而不是猜
    let rate = opts.voiceoverRate ?? null;
    if (rate == null) {
      const det = detectSpeakableFormat(root);
      rate = det ? det.info.rate : DEFAULT_RATE;
    }

    const missing: { idx: number; text: string; dbid: Buffer }[] = [];
    for (let i = 0; i < finalTracks.length; i++) {
      const dst = path.join(tracksDir, voiceFilename(finalTracks[i].dbid));
      if (exists(dst)) {
        result.voiceoverSkipped++;
        continue;
      }
      missing.push({
        idx: i,
        text: announceText(titles[i], artists[i]),
        dbid: finalTracks[i].dbid,
      });
    }

    if (missing.length > 0) report('voiceover', '生成中文语音…', 0, missing.length);
    for (let i = 0; i < missing.length; i++) {
      const m = missing[i];
      try {
        if (!m.text) throw new Error('播报文本为空');
        const { data } = await synthesize(m.text, {
          rate: rate ?? DEFAULT_RATE,
          voice: opts.voiceoverVoice ?? null,
          speed: opts.voiceoverSpeed ?? 0,
        });
        const dst = path.join(tracksDir, voiceFilename(m.dbid));
        atomicWriteFile(dst, data);
        result.voiceoverCreated++;
        report('voiceover', `语音：${m.text}`, i + 1, missing.length);
      } catch (e) {
        warnings.push(`语音生成失败「${m.text}」：${(e as Error).message}`);
      }
    }
    if (result.voiceoverCreated > 0 && !model.root.voiceover) {
      warnings.push('已生成语音文件，但设备数据库的 VoiceOver 总开关为关闭状态。');
    }
  } else {
    result.voiceoverSkipped = finalTracks.length;
  }

  // --- 7b. 边车元数据：给无标签的新曲目记下展示信息 ---------------------
  // 无标签音频写入设备后文件名是 JPSL 这类 4 字名、iTunesDB 也无条目，
  // 回读时标题会退化成文件名。这里把导入时解析出的标题/艺术家/专辑落盘，
  // loadLibrary 的第三级回退据此恢复正确展示（见 device.ts readTrackMeta）。
  if (result.added > 0 || result.removed > 0 || result.orphanRemoved > 0) {
    try {
      const meta = readTrackMeta(root);
      for (const t of removeList) meta.delete(t.filename.replace(/^\/+/, ''));
      const alive = new Set(finalTracks.map((t) => t.filename.replace(/^\/+/, '')));
      for (const key of [...meta.keys()]) if (!alive.has(key)) meta.delete(key);
      for (const p of pending) {
        if (!p.devicePath) continue;
        meta.set(p.absPath, {
          title: p.title,
          artist: p.info.tag.artist ?? '',
          album: p.info.tag.album ?? '',
        });
      }
      writeTrackMeta(root, meta);
    } catch (e) {
      warnings.push(`导入元数据写入失败（不影响同步结果）：${(e as Error).message}`);
    }
  }

  // --- 8. 刷盘 -------------------------------------------------------------
  report('flush', '刷盘…');
  const letter = root.replace(/:.*$/, '');
  if (!flushVolume(letter)) {
    warnings.push(
      '卷级刷盘需要管理员权限，本次已改为文件级刷盘。' +
        '断开前请务必使用「安全弹出」，否则设备可能读到旧数据库。',
    );
  }

  report('done', '完成');
  return result;
}

// ---------------------------------------------------------------- 小工具

function mostCommon(values: number[]): number | null {
  if (values.length === 0) return null;
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[0];
  let bestN = -1;
  for (const [v, n] of counts) {
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

/** 由文本派生一个稳定的非零分组 ID（保证同一专辑/艺术家得到同一个值） */
function stableId(text: string, fallback: number): number {
  const t = text.trim();
  if (!t) return fallback;
  const h = dbidFromText(t).readUInt32LE(0) & 0x7fffffff;
  return h === 0 ? fallback : h;
}

/**
 * 数据库完整性自检：把设备上的 iTunesSD 解析再重建，必须能逐字节还原。
 * 还原不出来就说明我们的解析对这份数据库是不完整的 —— 此时「哪些文件没被
 * 引用」这个判断不可信，清理孤儿的动作必须放弃（否则可能误删整库）。
 */
function roundTrips(sdPath: string): boolean {
  try {
    const raw = fs.readFileSync(sdPath);
    return buildSd(parseSd(raw)).equals(raw);
  } catch {
    return false;
  }
}

export { toPosix };
