/**
 * 核心数据模型。
 *
 * 字段命名与偏移量一一对应，偏移量注释即规格说明。
 * 所有数值均来自对真实设备 `iTunesSD` 的实测（见 docs/PLAN.md 第 2 节）。
 */

/** 曲目文件格式编号（写入 rths 记录 0x014） */
export const enum FileType {
  MP3 = 1,
  AAC = 2,
}

/** 单条曲目记录 `rths`，固定 372 字节（0x174） */
export interface TrackRecord {
  /** 0x004 头长度，恒为 0x174 */
  headerLength: number;
  /** 0x008 起始时间 ms，恒为 0 */
  startMs: number;
  /** 0x00C 结束时间 ms（即曲目时长） */
  stopMs: number;
  /** 0x010 音量增益 0..99 */
  volumeGain: number;
  /** 0x014 文件格式，1=MP3 2=AAC */
  filetype: number;
  /** 0x018 设备内路径，**带前导 `/`**，以 iPod 根为基准，UTF-8 编码，最长 255 字节 */
  filename: string;
  /** 0x118 书签位置 */
  bookmark: number;
  /** 0x11C 不参与随机播放（设备实测恒为 1） */
  dontskip: number;
  /** 0x11D */
  remember: number;
  /** 0x11E */
  unintalbum: number;
  /** 0x11F */
  unknown: number;
  /** 0x120 编码器起始延迟，设备实测 13 首恒为 528 */
  pregap: number;
  /** 0x124 尾部填充样本数，每首不同但极小 */
  postgap: number;
  /** 0x128 总样本数 ≈ round(时长秒 × 采样率) */
  numsamples: number;
  /** 0x12C */
  unk12c: number;
  /** 0x130 **音频流字节数**（文件大小 − ID3 开销），已实测吻合 */
  audioBytes: number;
  /** 0x134 */
  unk134: number;
  /** 0x138 专辑分组 ID */
  albumid: number;
  /** 0x13C 音轨号 */
  trackNo: number;
  /** 0x13E 碟号 */
  disc: number;
  /** 0x140 */
  unk140: bigint;
  /** 0x148 8 字节不透明标识符（与 VoiceOver 语音文件名成对） */
  dbid: Buffer;
  /** 0x150 艺术家分组 ID */
  artistid: number;
  /** 0x154..0x174 尾部 32 字节，设备实测全零 */
  tail: Buffer;
}

/** 播放列表记录 `lphs` */
export interface PlaylistRecord {
  /** 44 字节记录头（原样保留模板） */
  header: Buffer;
  /** 记录总长度 = 44 + nSongs × 4 */
  totalLength: number;
  /** 曲目数 */
  nSongs: number;
  /** 非音频项数 */
  nNonaudio: number;
  /** 播放列表 dbid，Master 列表实测为全零 */
  dbid: Buffer;
  /** 1 = Master（设备实测值），2 = 普通列表 */
  listtype: number;
  /** 成员为**曲目索引**（0 基），不是字节偏移 */
  members: number[];
}

/** iTunesSD 根头（64 字节） */
export interface SdRoot {
  /** 0x004 版本标记，本机 = 0x02010001 */
  version: number;
  /** 0x008 头长度字段，恒 64 */
  totalLen: number;
  /** 0x00C 曲目数 */
  nTracks: number;
  /** 0x010 播放列表数，shuffle 恒为 1（详见 itunessd.ts 注释） */
  nPlaylists: number;
  /** 0x014 */
  unkQ: bigint;
  /** 0x01C 最大音量限制 0..99 */
  maxVolume: number;
  /** 0x01D **VoiceOver 总开关**（全局，非逐曲）。置 0 会整机静音 */
  voiceover: number;
  /** 0x01E */
  unkH: number;
  /** 0x020 */
  tracksWoPodcasts: number;
  /** 0x024 曲目区偏移，恒 64 */
  trackHeaderOffset: number;
  /** 0x028 播放列表区偏移 */
  playlistHeaderOffset: number;
  /** 0x02C..0x040 模板尾部 20 字节 */
  tail: Buffer;
}

export interface SdModel {
  root: SdRoot;
  tracks: TrackRecord[];
  /** `hphs` 头部（68 + n×4 字节，n=1 时 72 字节） */
  playlistHeader: Buffer;
  playlists: PlaylistRecord[];
}

/** 音频文件解析结果 */
export interface AudioInfo {
  /** 容器类型 */
  container: 'mp3' | 'm4a';
  /** 写入 iTunesSD 的格式编号 */
  filetype: number;
  /** 时长 ms */
  durationMs: number;
  sampleRate: number;
  channels: number;
  bitrate: number;
  /** 音频流字节数（不含标签开销） */
  audioBytes: number;
  /** 文件总大小 */
  fileSize: number;
  tag: AudioTag;
}

export interface AudioTag {
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  year?: string;
  /** 音轨号（含总数） */
  trackNo?: number;
  trackTotal?: number;
  discNo?: number;
  comment?: string;
}

/** 界面上展示的一条曲目（iTunesSD 记录 + 解析出的元数据） */
export interface TrackView {
  /** 稳定标识：dbid 的十六进制 */
  id: string;
  /** 设备内路径 */
  filename: string;
  /** 显示标题（已按 ID3 → iTunesDB → 文件名 回退） */
  title: string;
  artist: string;
  album: string;
  /** 时长 ms */
  durationMs: number;
  /** 文件大小字节 */
  fileSize: number;
  /** 'MP3' | 'AAC' */
  format: string;
  /** 元数据来源 */
  source: 'id3' | 'itunesdb' | 'filename';
  /** 文件是否真实存在（数据库里可能残留已丢失文件的条目） */
  exists: boolean;
  /** 是否已有 VoiceOver 语音 */
  hasVoiceover: boolean;
}

/** 待写入设备的变更计划 */
export interface SyncPlan {
  toAdd: LocalTrack[];
  toRemove: string[];
}

/** 来自本地磁盘、准备导入的曲目 */
export interface LocalTrack {
  /** 源文件绝对路径 */
  path: string;
  fileName: string;
  fileSize: number;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  format: string;
  /** 解析失败时的原因 */
  error?: string;
}

export interface DeviceInfo {
  /** 根路径，形如 `F:/` */
  root: string;
  driveLetter: string;
  volumeLabel: string;
  totalBytes: number;
  freeBytes: number;
  /** iTunesSD 解析出的曲目数 */
  trackCount: number;
  /** Music/ 下实际文件数 */
  fileCount: number;
  usedByMusicBytes: number;
  voiceoverSupported: boolean;
  voiceoverEnabled: boolean;
  /** 版本标记，用于诊断 */
  version: number;
}

export interface SyncResult {
  added: number;
  removed: number;
  voiceoverCreated: number;
  voiceoverSkipped: number;
  bytesWritten: number;
  backupPath: string | null;
  /** 数据库里有记录、但文件已不存在 → 自动清除的记录数 */
  ghostPruned: number;
  /** Music/ 里存在、但数据库没有引用 → 自动删除的文件数 */
  orphanRemoved: number;
  /** Speakable/Tracks 里已无对应曲目 → 自动删除的语音文件数 */
  orphanVoiceRemoved: number;
  /** 因安全检查未通过而放弃清理的孤儿文件数（0 = 正常清理完毕） */
  orphanKept: number;
  warnings: string[];
}
