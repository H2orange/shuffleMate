/**
 * iTunesSD 解析与序列化 —— iPod Shuffle 的播放数据库。
 *
 * 重要：shuffle 播放读的是 `iPod_Control/iTunes/iTunesSD`（根 chunk `bdhs`），
 * **不是** `iTunesDB`。`iTunesDB` 只是 Apple 自己的记账文件，本工具只读它取标题。
 *
 * 该格式无需任何签名 / 加密哈希（经典 iPod 的 hash58/hash72/hashAB 在 shuffle 上不存在），
 * 这是纯软件实现可行的根本原因。
 *
 * 本实现是 `tools/itunessd-reference.py` 的 TypeScript 移植，
 * 已通过「解析设备原文件 → 重新序列化 → 逐字节比对」验证（回归测试见 scripts/test-core.js）。
 *
 * 文件布局
 * --------
 *   [0x00]                    根头 64 字节（bdhs）
 *   [0x40]                    hths 曲目头：20 字节 + n×4 偏移表
 *   [0x40 + 20 + n*4]         n × 372 字节曲目记录（rths）
 *   [playlistHeaderOffset]    hphs 播放列表头：68 + m×4 字节
 *   [lphs...]                 m 条播放列表记录（lphs）
 */
import {
  FileType,
  PlaylistRecord,
  SdModel,
  SdRoot,
  TrackRecord,
} from './types';

/** 曲目记录固定长度（0x174） */
export const TRACK_RECORD_SIZE = 372;
/** 根头长度 */
export const ROOT_HEADER_SIZE = 64;
/** hths 头长度（4s + I + I + Q） */
export const TRACK_HEADER_SIZE = 20;
/** 播放列表记录头长度 */
export const PLAYLIST_RECORD_HEADER = 44;
/** hphs 中偏移表之前的固定部分 */
export const PLAYLIST_HEADER_PREFIX = 68;

const MAGIC_ROOT = 'bdhs';
const MAGIC_TRACK_HEADER = 'hths';
const MAGIC_TRACK = 'rths';
const MAGIC_PLAYLIST_HEADER = 'hphs';
const MAGIC_PLAYLIST = 'lphs';

function magic(buf: Buffer, offset: number, expect: string): void {
  const got = buf.toString('latin1', offset, offset + 4);
  if (got !== expect) {
    throw new Error(
      `iTunesSD 结构异常：偏移 ${offset} 期望 '${expect}'，实际 '${got}'。` +
        `文件可能不是本工具支持的格式版本。`,
    );
  }
}

// ---------------------------------------------------------------- 解析

export function parseSd(data: Buffer): SdModel {
  if (data.length < ROOT_HEADER_SIZE) {
    throw new Error(`iTunesSD 太短（${data.length} 字节）`);
  }
  magic(data, 0, MAGIC_ROOT);

  const root: SdRoot = {
    version: data.readUInt32LE(0x04),
    totalLen: data.readUInt32LE(0x08),
    nTracks: data.readUInt32LE(0x0c),
    nPlaylists: data.readUInt32LE(0x10),
    unkQ: data.readBigUInt64LE(0x14),
    maxVolume: data[0x1c],
    voiceover: data[0x1d],
    unkH: data.readUInt16LE(0x1e),
    tracksWoPodcasts: data.readUInt32LE(0x20),
    trackHeaderOffset: data.readUInt32LE(0x24),
    playlistHeaderOffset: data.readUInt32LE(0x28),
    tail: Buffer.from(data.subarray(0x2c, 0x40)),
  };

  // --- 曲目区 ---
  const trkOff = root.trackHeaderOffset;
  magic(data, trkOff, MAGIC_TRACK_HEADER);
  // 注意：头长度字段（+4）是 (20 + n*4)，不是整个曲目块长度；
  // 而 +12 处的 8 字节 Q 是 unknown1，偏移表紧跟在 20 字节头之后。
  const thN = data.readUInt32LE(trkOff + 0x08);
  if (thN !== root.nTracks) {
    // 不致命，但值得暴露出来，便于诊断被外部工具改坏的文件
    console.warn(
      `[itunessd] hths 曲目数(${thN}) 与根头 nTracks(${root.nTracks}) 不一致`,
    );
  }
  const offsets: number[] = [];
  for (let i = 0; i < thN; i++) {
    const p = trkOff + TRACK_HEADER_SIZE + i * 4;
    if (p + 4 > data.length) {
      throw new Error('iTunesSD 曲目偏移表越界');
    }
    offsets.push(data.readUInt32LE(p));
  }

  const tracks: TrackRecord[] = offsets.map((o) => {
    if (o + TRACK_RECORD_SIZE > data.length) {
      throw new Error(`曲目记录越界：偏移 ${o}`);
    }
    return parseTrack(data.subarray(o, o + TRACK_RECORD_SIZE));
  });

  // --- 播放列表区 ---
  const plOff = root.playlistHeaderOffset;
  magic(data, plOff, MAGIC_PLAYLIST_HEADER);
  const plCount = data.readUInt32LE(plOff + 0x08);
  const headerSize = PLAYLIST_HEADER_PREFIX + plCount * 4;
  const playlistHeader = Buffer.from(data.subarray(plOff, plOff + headerSize));

  const playlists: PlaylistRecord[] = [];
  for (let k = 0; k < plCount; k++) {
    const slot = plOff + PLAYLIST_HEADER_PREFIX + k * 4;
    if (slot + 4 > data.length) break;
    const lo = data.readUInt32LE(slot);
    if (!lo) continue;
    playlists.push(parsePlaylist(data, lo));
  }

  return { root, tracks, playlistHeader, playlists };
}

export function parseTrack(r: Buffer): TrackRecord {
  magic(r, 0, MAGIC_TRACK);
  const filenameRaw = r.subarray(0x18, 0x118);
  const nul = filenameRaw.indexOf(0);
  return {
    headerLength: r.readUInt32LE(0x04),
    startMs: r.readUInt32LE(0x08),
    stopMs: r.readUInt32LE(0x0c),
    volumeGain: r.readUInt32LE(0x10),
    filetype: r.readUInt32LE(0x14),
    filename: filenameRaw
      .subarray(0, nul < 0 ? filenameRaw.length : nul)
      .toString('utf8'),
    bookmark: r.readUInt32LE(0x118),
    dontskip: r[0x11c],
    remember: r[0x11d],
    unintalbum: r[0x11e],
    unknown: r[0x11f],
    pregap: r.readUInt32LE(0x120),
    postgap: r.readUInt32LE(0x124),
    numsamples: r.readUInt32LE(0x128),
    unk12c: r.readUInt32LE(0x12c),
    audioBytes: r.readUInt32LE(0x130),
    unk134: r.readUInt32LE(0x134),
    albumid: r.readUInt32LE(0x138),
    trackNo: r.readUInt16LE(0x13c),
    disc: r.readUInt16LE(0x13e),
    unk140: r.readBigUInt64LE(0x140),
    dbid: Buffer.from(r.subarray(0x148, 0x150)),
    artistid: r.readUInt32LE(0x150),
    tail: Buffer.from(r.subarray(0x154, 0x174)),
  };
}

export function parsePlaylist(data: Buffer, off: number): PlaylistRecord {
  magic(data, off, MAGIC_PLAYLIST);
  const nSongs = data.readUInt32LE(off + 0x08);
  const members: number[] = [];
  for (let i = 0; i < nSongs; i++) {
    const p = off + PLAYLIST_RECORD_HEADER + i * 4;
    if (p + 4 > data.length) break;
    members.push(data.readUInt32LE(p));
  }
  return {
    header: Buffer.from(data.subarray(off, off + PLAYLIST_RECORD_HEADER)),
    totalLength: data.readUInt32LE(off + 0x04),
    nSongs,
    nNonaudio: data.readUInt32LE(off + 0x0c),
    dbid: Buffer.from(data.subarray(off + 0x10, off + 0x18)),
    listtype: data.readUInt32LE(off + 0x18),
    members,
  };
}

// ---------------------------------------------------------------- 序列化

export function buildTrack(t: TrackRecord): Buffer {
  const out = Buffer.alloc(TRACK_RECORD_SIZE);
  out.write(MAGIC_TRACK, 0, 'latin1');
  out.writeUInt32LE(t.headerLength || TRACK_RECORD_SIZE, 0x04);
  out.writeUInt32LE(t.startMs, 0x08);
  out.writeUInt32LE(t.stopMs, 0x0c);
  out.writeUInt32LE(t.volumeGain, 0x10);
  out.writeUInt32LE(t.filetype, 0x14);

  const name = Buffer.from(t.filename, 'utf8');
  if (name.length > 255) {
    throw new Error(`曲目路径过长（${name.length} > 255 字节）：${t.filename}`);
  }
  name.copy(out, 0x18);

  out.writeUInt32LE(t.bookmark, 0x118);
  out[0x11c] = t.dontskip;
  out[0x11d] = t.remember;
  out[0x11e] = t.unintalbum;
  out[0x11f] = t.unknown;
  out.writeUInt32LE(t.pregap, 0x120);
  out.writeUInt32LE(t.postgap, 0x124);
  out.writeUInt32LE(t.numsamples, 0x128);
  out.writeUInt32LE(t.unk12c, 0x12c);
  out.writeUInt32LE(t.audioBytes, 0x130);
  out.writeUInt32LE(t.unk134, 0x134);
  out.writeUInt32LE(t.albumid, 0x138);
  out.writeUInt16LE(t.trackNo, 0x13c);
  out.writeUInt16LE(t.disc, 0x13e);
  out.writeBigUInt64LE(t.unk140, 0x140);
  t.dbid.copy(out, 0x148, 0, 8);
  out.writeUInt32LE(t.artistid, 0x150);
  t.tail.copy(out, 0x154, 0, 32);
  return out;
}

/**
 * 序列化整个 iTunesSD。
 *
 * 头部模板整体沿用设备现有的值（版本标记、VoiceOver 开关、最大音量、模板尾部），
 * **不硬编码任何版本常量** —— 这样既适配本机的 0x02010001，也兼容其他代数。
 */
export function buildSd(model: SdModel): Buffer {
  const { tracks, root, playlists } = model;
  const n = tracks.length;

  const out = Buffer.alloc(ROOT_HEADER_SIZE);
  out.write(MAGIC_ROOT, 0, 'latin1');
  out.writeUInt32LE(root.version, 0x04);
  out.writeUInt32LE(ROOT_HEADER_SIZE, 0x08);
  out.writeUInt32LE(n, 0x0c);
  out.writeUInt32LE(root.nPlaylists, 0x10);
  out.writeBigUInt64LE(0n, 0x14);
  out[0x1c] = root.maxVolume & 0xff;
  out[0x1d] = root.voiceover ? 1 : 0; // VoiceOver 总开关，必须原样保留
  out.writeUInt16LE(0, 0x1e);
  out.writeUInt32LE(n, 0x20);
  root.tail.copy(out, 0x2c, 0, 20);

  // --- 曲目块 ---
  const thSize = TRACK_HEADER_SIZE + n * 4;
  const hunks: Buffer[] = [];
  const offsets = Buffer.alloc(n * 4);
  let cursor = ROOT_HEADER_SIZE + thSize;
  for (let i = 0; i < n; i++) {
    offsets.writeUInt32LE(cursor, i * 4);
    hunks.push(buildTrack(tracks[i]));
    cursor += TRACK_RECORD_SIZE;
  }
  const trk = Buffer.concat([
    headerChunk(MAGIC_TRACK_HEADER, thSize, n),
    offsets,
    ...hunks,
  ]);

  // --- 播放列表头 ---
  const ph = Buffer.from(model.playlistHeader);
  ph.writeUInt32LE(ph.length, 0x04);
  ph.writeUInt32LE(playlists.length, 0x08);
  const firstLphs = ROOT_HEADER_SIZE + trk.length + ph.length;
  for (let k = 0; k < playlists.length; k++) {
    const slot = PLAYLIST_HEADER_PREFIX + k * 4;
    if (slot + 4 > ph.length) break;
    ph.writeUInt32LE(k === 0 ? firstLphs : 0, slot);
  }

  out.writeUInt32LE(ROOT_HEADER_SIZE, 0x24);
  out.writeUInt32LE(ROOT_HEADER_SIZE + trk.length, 0x28);

  // --- 播放列表记录 ---
  const plParts: Buffer[] = [];
  for (const p of playlists) {
    const h = Buffer.from(p.header);
    h.writeUInt32LE(PLAYLIST_RECORD_HEADER + p.nSongs * 4, 0x04);
    h.writeUInt32LE(p.nSongs, 0x08);
    h.writeUInt32LE(p.nNonaudio, 0x0c);
    const mem = Buffer.alloc(p.nSongs * 4);
    p.members.forEach((m, i) => mem.writeUInt32LE(m, i * 4));
    plParts.push(h, mem);
  }

  return Buffer.concat([out, trk, ph, ...plParts]);
}

/** hths 头：magic + 偏移表长度 + 曲目数 + 8 字节 unknown1 */
function headerChunk(magic_: string, tableSize: number, count: number): Buffer {
  const b = Buffer.alloc(TRACK_HEADER_SIZE);
  b.write(magic_, 0, 'latin1');
  b.writeUInt32LE(tableSize, 0x04);
  b.writeUInt32LE(count, 0x08);
  b.writeBigUInt64LE(0n, 0x0c);
  return b;
}

// ---------------------------------------------------------------- 工具

/** 生成全新的曲目记录（用于新增文件）。存量曲目一律沿用设备原记录。 */
export function makeTrackRecord(opts: {
  filename: string;
  filetype: number;
  durationMs: number;
  sampleRate: number;
  audioBytes: number;
  dbid: Buffer;
  pregap: number;
  albumid: number;
  artistid: number;
  trackNo?: number;
  disc?: number;
  volumeGain?: number;
}): TrackRecord {
  return {
    headerLength: TRACK_RECORD_SIZE,
    startMs: 0,
    stopMs: Math.max(0, Math.round(opts.durationMs)),
    volumeGain: opts.volumeGain ?? 0,
    filetype: opts.filetype,
    filename: opts.filename,
    bookmark: 0,
    // 设备上 Apple 写入的 13 条记录该字节恒为 1，沿用以免参与随机播放行为异常
    dontskip: 1,
    remember: 0,
    unintalbum: 0,
    unknown: 0,
    pregap: opts.pregap,
    postgap: 0,
    numsamples: Math.round((opts.durationMs / 1000) * opts.sampleRate),
    unk12c: 0,
    audioBytes: opts.audioBytes,
    unk134: 0,
    albumid: opts.albumid,
    trackNo: opts.trackNo ?? 0,
    disc: opts.disc ?? 0,
    unk140: 0n,
    dbid: opts.dbid,
    artistid: opts.artistid,
    tail: Buffer.alloc(32),
  };
}

/** 用设备现有曲目重排成新的完整模型（曲目全部保留、顺序不变，重写 Master 列表）。 */
export function withTracks(
  template: SdModel,
  tracks: TrackRecord[],
  maxVolume = template.root.maxVolume,
): SdModel {
  const master = template.playlists[0];
  const header = master
    ? Buffer.from(master.header)
    : Buffer.alloc(PLAYLIST_RECORD_HEADER);
  if (!master) {
    header.write(MAGIC_PLAYLIST, 0, 'latin1');
  }
  const playlists: PlaylistRecord[] = [
    {
      header,
      totalLength: PLAYLIST_RECORD_HEADER + tracks.length * 4,
      nSongs: tracks.length,
      nNonaudio: tracks.length,
      dbid: Buffer.alloc(8),
      listtype: master ? master.listtype : 1,
      members: tracks.map((_, i) => i),
    },
  ];
  return {
    root: { ...template.root, nTracks: tracks.length, nPlaylists: 1, maxVolume },
    tracks,
    playlistHeader: Buffer.from(template.playlistHeader),
    playlists,
  };
}

export { FileType };
