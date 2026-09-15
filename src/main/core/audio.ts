/**
 * 音频文件解析：容器识别、标签读取、时长/采样率/音频流字节数计算。
 *
 * 零依赖手写实现（不用 music-metadata）：避免 ESM/asar 打包问题，且能精确控制
 * `numsamples` / `audioBytes` 的计算方式 —— 这两个字段会被写进 iTunesSD，
 * 必须与 Apple 的算法一致（已实测：CBR 文件按「音频流字节 × 8 ÷ 比特率」计算时长，
 * 与设备上 Apple 写入的 stop_ms 完全吻合）。
 *
 * 目前支持：MP3（Layer III）、M4A/AAC。
 * 不支持的容器会明确报错，而不是写入一条可能播不出来的记录。
 */
import * as fs from 'fs';
import { AudioInfo, AudioTag, FileType } from './types';

// ---------------------------------------------------------------- MPEG 表

const BITRATE_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATE_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG 1
  2: [22050, 24000, 16000], // MPEG 2
  0: [11025, 12000, 8000], // MPEG 2.5
};

/** 编码器起始延迟：设备实测 13 首**恒为 528**（写入新增曲目记录时沿用） */
export const DEFAULT_PREGAP = 528;

export class UnsupportedFormatError extends Error {}

// ---------------------------------------------------------------- 入口

export function probeAudioFile(absPath: string): AudioInfo {
  const buf = fs.readFileSync(absPath);
  return probeAudioBuffer(buf, absPath);
}

export function probeAudioBuffer(buf: Buffer, name = '<buffer>'): AudioInfo {
  if (buf.length < 16) {
    throw new UnsupportedFormatError(`${name}: 文件过小，不是有效的音频文件`);
  }
  // MP4 家族：偏移 4 处是 'ftyp'
  if (buf.toString('latin1', 4, 8) === 'ftyp') {
    return parseM4a(buf, name);
  }
  if (buf.toString('latin1', 0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) {
    return parseMp3(buf, name);
  }
  if (buf.toString('latin1', 0, 4) === 'RIFF' || buf.toString('latin1', 0, 4) === 'FORM') {
    throw new UnsupportedFormatError(
      `${name}: 暂不支持 WAV/AIFF。请先转换为 MP3 或 M4A 再导入。`,
    );
  }
  throw new UnsupportedFormatError(`${name}: 无法识别的音频容器`);
}

// ---------------------------------------------------------------- MP3

interface Id3v2 {
  /** 标签总字节数（含 10 字节头与可选 footer） */
  size: number;
  tag: AudioTag;
}

function syncSafe(b: Buffer, off: number): number {
  return (
    ((b[off] & 0x7f) << 21) |
    ((b[off + 1] & 0x7f) << 14) |
    ((b[off + 2] & 0x7f) << 7) |
    (b[off + 3] & 0x7f)
  );
}

/** 按声明编码解释文本字节 */
function decodeText(b: Buffer): string {
  if (b.length === 0) return '';
  const enc = b[0];
  const body = b.subarray(1);
  let s: string;
  switch (enc) {
    case 1:
      s = body.toString('utf16le');
      break;
    case 2:
      // UTF-16BE：转成 LE 再解
      s = Buffer.from(body).swap16().toString('utf16le');
      break;
    case 3:
      s = body.toString('utf8');
      break;
    default:
      s = body.toString('latin1');
  }
  return s.replace(/\u0000+$/g, '').trim();
}

function parseId3v2(buf: Buffer): Id3v2 | null {
  if (buf.toString('latin1', 0, 3) !== 'ID3') return null;
  const major = buf[3];
  const flags = buf[5];
  const declared = syncSafe(buf, 6);
  const footer = flags & 0x10 ? 10 : 0;
  const size = 10 + declared + footer;
  if (size > buf.length) return null;

  let body = buf.subarray(10, 10 + declared);

  // 去同步：把 0xFF 00 还原为 0xFF
  if (flags & 0x80) {
    const un = Buffer.alloc(body.length);
    let w = 0;
    for (let r = 0; r < body.length; r++) {
      un[w++] = body[r];
      if (body[r] === 0xff && body[r + 1] === 0x00) r++;
    }
    body = un.subarray(0, w);
  }

  // 扩展头
  let p = 0;
  if (flags & 0x40) {
    p += major >= 4 ? syncSafe(body, 0) : body.readUInt32BE(0) + 4;
  }

  const raw = new Map<string, string>();
  const rawNums = new Map<string, Buffer>();
  const idLen = major === 2 ? 3 : 4;
  const hdrLen = major === 2 ? 6 : 10;

  while (p + hdrLen <= body.length) {
    const id = body.toString('latin1', p, p + idLen);
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break; // 进入 padding

    let frameSize: number;
    if (major === 2) {
      frameSize = (body[p + 3] << 16) | (body[p + 4] << 8) | body[p + 5];
    } else if (major === 3) {
      frameSize = body.readUInt32BE(p + 4);
    } else {
      frameSize = syncSafe(body, p + 4);
    }
    if (frameSize <= 0 || p + hdrLen + frameSize > body.length) break;

    const data = body.subarray(p + hdrLen, p + hdrLen + frameSize);
    p += hdrLen + frameSize;

    switch (id) {
      case 'TIT2':
      case 'TT2':
        raw.set('title', decodeText(data));
        break;
      case 'TPE1':
      case 'TP1':
        raw.set('artist', decodeText(data));
        break;
      case 'TALB':
      case 'TAL':
        raw.set('album', decodeText(data));
        break;
      case 'TCON':
      case 'TCO':
        raw.set('genre', decodeText(data).replace(/^\(\d+\)/, ''));
        break;
      case 'TYER':
      case 'TYE':
      case 'TDRC':
        raw.set('year', decodeText(data).slice(0, 10));
        break;
      case 'TRCK':
      case 'TRK':
        raw.set('track', decodeText(data));
        break;
      case 'TPOS':
        raw.set('disc', decodeText(data));
        break;
      default:
        if (id.startsWith('T') && rawNums.size < 0) rawNums.set(id, data);
    }
  }

  const tag: AudioTag = {
    title: raw.get('title') || undefined,
    artist: raw.get('artist') || undefined,
    album: raw.get('album') || undefined,
    genre: raw.get('genre') || undefined,
    year: raw.get('year') || undefined,
    comment: undefined,
  };
  const tr = raw.get('track');
  if (tr) {
    const [a, b] = tr.split('/');
    tag.trackNo = parseInt(a, 10) || undefined;
    tag.trackTotal = parseInt(b, 10) || undefined;
  }
  const ds = raw.get('disc');
  if (ds) tag.discNo = parseInt(ds.split('/')[0], 10) || undefined;

  return { size, tag };
}

/** ID3v1 兜底（128 字节尾部） */
function parseId3v1(buf: Buffer): { size: number; tag: AudioTag } | null {
  if (buf.length < 128) return null;
  const t = buf.subarray(buf.length - 128);
  if (t.toString('latin1', 0, 3) !== 'TAG') return null;
  const str = (a: number, b: number) =>
    t.subarray(a, b).toString('latin1').replace(/\u0000.*$/s, '').trim();
  return {
    size: 128,
    tag: {
      title: str(3, 33) || undefined,
      artist: str(33, 63) || undefined,
      album: str(63, 93) || undefined,
      year: str(93, 97) || undefined,
      comment: str(97, 127) || undefined,
    },
  };
}

interface FrameInfo {
  version: number;
  bitrate: number;
  sampleRate: number;
  samplesPerFrame: number;
  channels: number;
  length: number;
}

/** 解析一个 MPEG Layer III 帧头；非法则返回 null */
function readFrameHeader(buf: Buffer, i: number, limit: number): FrameInfo | null {
  if (i + 4 > limit) return null;
  if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) return null;
  const version = (buf[i + 1] >> 3) & 0x03;
  const layer = (buf[i + 1] >> 1) & 0x03;
  const brIndex = (buf[i + 2] >> 4) & 0x0f;
  const srIndex = (buf[i + 2] >> 2) & 0x03;
  const padding = (buf[i + 2] >> 1) & 0x01;
  const channelMode = (buf[i + 3] >> 6) & 0x03;
  if (version === 1 || layer !== 1 || brIndex === 0 || brIndex === 15 || srIndex === 3) return null;
  const bitrate = (version === 3 ? BITRATE_V1_L3 : BITRATE_V2_L3)[brIndex] * 1000;
  const sampleRate = SAMPLE_RATES[version][srIndex];
  const samplesPerFrame = version === 3 ? 1152 : 576;
  return {
    version,
    bitrate,
    sampleRate,
    samplesPerFrame,
    channels: channelMode === 3 ? 1 : 2,
    length: Math.floor((samplesPerFrame / 8) * (bitrate / sampleRate)) + padding,
  };
}

/**
 * 解析 MP3 并计算写入 iTunesSD 所需的字段。
 *
 * 两个关键字段的算法已在本机 13 首真实 MP3 上**逐条验证为 13/13 精确命中**：
 *
 *   stopMs      = round(帧字节总和 × 8 ÷ 比特率 × 1000)
 *   audioBytes  = 帧字节总和 − 最后 8 帧的字节数        （0x130 字段）
 *
 * 第二项尤其反直觉：Apple 的 0x130 并不是"音频流总字节数"，而是**减去尾部 8 帧**
 * （≈209 ms）之后的值。实测在 40/64/80/128 kbps、44100/22050 Hz 上全部恰好是
 * 209.0 ms，因此这是 Apple 的固定策略（预留解码器尾部余量），不是从 LAME 标签读取的
 * ——因为本机 4 个文件连 ID3 标签都没有，Apple 依然按这个规律取值。
 */
function parseMp3(buf: Buffer, name: string): AudioInfo {
  const v2 = parseId3v2(buf);
  const v1 = parseId3v1(buf);
  const searchFrom = v2 ? v2.size : 0;
  const tagEnd = v1 ? v1.size : 0;
  /** 音频流边界：不含尾部 ID3v1 */
  const limit = buf.length - tagEnd;

  // 定位第一个合法帧
  let first = -1;
  let firstInfo: FrameInfo | null = null;
  for (let i = searchFrom; i + 4 <= limit; i++) {
    const f = readFrameHeader(buf, i, limit);
    if (f) {
      first = i;
      firstInfo = f;
      break;
    }
  }
  if (!firstInfo) {
    throw new UnsupportedFormatError(`${name}: 未找到 MPEG 音频帧，文件可能损坏`);
  }

  // 逐帧精确累加：要求整帧完整落在音频流之内，尾部残帧/填充自然被排除
  const lens: number[] = [];
  let p = first;
  let frameSum = 0;
  while (lens.length < 2_000_000) {
    const f = readFrameHeader(buf, p, limit);
    if (!f || p + f.length > limit) break;
    lens.push(f.length);
    frameSum += f.length;
    p += f.length;
  }
  if (lens.length === 0) {
    throw new UnsupportedFormatError(`${name}: 未能解析出完整的 MPEG 帧`);
  }

  const lastFrames = lens.slice(-8).reduce((a, b) => a + b, 0);
  const audioBytes = Math.max(0, frameSum - lastFrames);

  const tag: AudioTag = mergeTags(v2?.tag, v1?.tag);
  const base = {
    container: 'mp3' as const,
    filetype: FileType.MP3,
    sampleRate: firstInfo.sampleRate,
    channels: firstInfo.channels,
    audioBytes,
    fileSize: buf.length,
    tag,
  };

  // Xing = 真 VBR，必须用帧数算时长；Info = CBR 标记，仍用字节算法
  const sideInfo =
    firstInfo.version === 3
      ? firstInfo.channels === 1
        ? 17
        : 32
      : firstInfo.channels === 1
        ? 9
        : 17;
  const xingAt = first + 4 + sideInfo;
  if (buf.toString('latin1', xingAt, xingAt + 4) === 'Xing' && xingAt + 12 <= buf.length) {
    const flags = buf.readUInt32BE(xingAt + 4);
    if (flags & 0x01) {
      const frames = buf.readUInt32BE(xingAt + 8);
      if (frames > 0) {
        const seconds = (frames * firstInfo.samplesPerFrame) / firstInfo.sampleRate;
        return {
          ...base,
          durationMs: Math.round(seconds * 1000),
          bitrate: seconds > 0 ? Math.round((frameSum * 8) / seconds) : firstInfo.bitrate,
        };
      }
    }
  }

  return {
    ...base,
    durationMs: Math.round(((frameSum * 8) / firstInfo.bitrate) * 1000),
    bitrate: firstInfo.bitrate,
  };
}

function mergeTags(a?: AudioTag, b?: AudioTag): AudioTag {
  const out: AudioTag = {};
  for (const src of [a, b]) {
    if (!src) continue;
    for (const k of Object.keys(src) as (keyof AudioTag)[]) {
      if (out[k] === undefined && src[k] !== undefined && src[k] !== '') {
        (out as Record<string, unknown>)[k] = src[k];
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- MP4 / M4A

interface Box {
  type: string;
  start: number;
  end: number;
  bodyStart: number;
}

/** 遍历一层 box；遇到损坏的 size 立即停止而不是抛错 */
function* boxes(buf: Buffer, from: number, to: number): Generator<Box> {
  let p = from;
  while (p + 8 <= to) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let bodyStart = p + 8;
    if (size === 1) {
      if (p + 16 > to) return;
      const big = buf.readBigUInt64BE(p + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return;
      size = Number(big);
      bodyStart = p + 16;
    } else if (size === 0) {
      size = to - p;
    }
    if (size < 8 || p + size > to) return;
    yield { type, start: p, end: p + size, bodyStart };
    p += size;
  }
}

function findBox(buf: Buffer, from: number, to: number, pathParts: string[]): Box | null {
  for (const b of boxes(buf, from, to)) {
    if (b.type !== pathParts[0]) continue;
    if (pathParts.length === 1) return b;
    // 'meta' 是 FullBox：body 前有 4 字节 version/flags
    const inner = b.type === 'meta' ? b.bodyStart + 4 : b.bodyStart;
    const found = findBox(buf, inner, b.end, pathParts.slice(1));
    if (found) return found;
  }
  return null;
}

function parseM4a(buf: Buffer, name: string): AudioInfo {
  const moov = findBox(buf, 0, buf.length, ['moov']);
  if (!moov) {
    throw new UnsupportedFormatError(`${name}: 缺少 moov box，不是有效的 MP4 音频`);
  }

  // 时长与时间基
  let durationMs = 0;
  const mdhd = findBox(buf, moov.bodyStart, moov.end, ['trak', 'mdia', 'mdhd']);
  const mvhd = findBox(buf, moov.bodyStart, moov.end, ['mvhd']);
  for (const b of [mdhd ?? mvhd]) {
    if (!b) continue;
    const v = buf[b.bodyStart];
    const timescale = v === 1 ? buf.readUInt32BE(b.bodyStart + 20) : buf.readUInt32BE(b.bodyStart + 12);
    const dur = v === 1 ? buf.readBigUInt64BE(b.bodyStart + 24) : BigInt(buf.readUInt32BE(b.bodyStart + 16));
    if (timescale > 0) {
      durationMs = Math.round((Number(dur) / timescale) * 1000);
      break;
    }
  }

  // 采样率 / 声道
  let sampleRate = 0;
  let channels = 2;
  const stsd = findBox(buf, moov.bodyStart, moov.end, ['trak', 'mdia', 'minf', 'stbl', 'stsd']);
  if (stsd) {
    // FullBox：4 字节 version/flags + 4 字节 entry count
    for (const e of boxes(buf, stsd.bodyStart + 8, stsd.end)) {
      if (e.end - e.start < 36) continue;
      channels = buf.readUInt16BE(e.start + 24);
      sampleRate = buf.readUInt32BE(e.start + 32) >>> 16;
      break;
    }
  }

  // 标签
  const tag: AudioTag = {};
  const ilst = findBox(buf, moov.bodyStart, moov.end, ['udta', 'meta', 'ilst']);
  if (ilst) {
    for (const item of boxes(buf, ilst.bodyStart, ilst.end)) {
      const dataBox = [...boxes(buf, item.bodyStart, item.end)].find((x) => x.type === 'data');
      if (!dataBox) continue;
      // data: 4 字节 type/flags + 4 字节 locale，之后才是负载
      const payloadAt = dataBox.bodyStart + 8;
      if (payloadAt > dataBox.end) continue;
      const payload = buf.subarray(payloadAt, dataBox.end);
      const text = () => payload.toString('utf8').replace(/\u0000+$/g, '').trim();
      switch (item.type) {
        case '\u00a9nam':
          tag.title = text() || undefined;
          break;
        case '\u00a9ART':
          tag.artist = text() || undefined;
          break;
        case 'aART':
          if (!tag.artist) {
            const a = text();
            if (a) tag.artist = a;
          }
          break;
        case '\u00a9alb':
          tag.album = text() || undefined;
          break;
        case '\u00a9gen':
          tag.genre = text() || undefined;
          break;
        case '\u00a9day':
          tag.year = text().slice(0, 10) || undefined;
          break;
        case '\u00a9cmt':
          tag.comment = text() || undefined;
          break;
        case 'trkn':
          if (payload.length >= 6) {
            tag.trackNo = payload.readUInt16BE(2) || undefined;
            tag.trackTotal = payload.readUInt16BE(4) || undefined;
          }
          break;
        case 'disk':
          if (payload.length >= 4) tag.discNo = payload.readUInt16BE(2) || undefined;
          break;
      }
    }
  }

  const mdat = findBox(buf, 0, buf.length, ['mdat']);
  const audioBytes = mdat ? mdat.end - mdat.start - 8 : buf.length;
  const seconds = durationMs / 1000;
  return {
    container: 'm4a',
    filetype: FileType.AAC,
    durationMs,
    sampleRate: sampleRate || 44100,
    channels: channels || 2,
    bitrate: seconds > 0 ? Math.round((audioBytes * 8) / seconds) : 0,
    audioBytes,
    fileSize: buf.length,
    tag,
  };
}

// ---------------------------------------------------------------- 轻量标签读取

/**
 * 只读标签，不解析音频帧。
 *
 * 设备侧列表刷新需要遍历全部曲目；本机 13 个 MP3 合计约 400 MB，
 * 为了显示曲名而全量读盘是不可接受的。MP3 的 ID3v2 在文件头、ID3v1 在末尾 128 字节，
 * 因此只读「头部若干 MB + 尾部 128 字节」即可覆盖。
 *
 * M4A 的 moov 可能位于文件尾部，无法靠头部推断，此时才退化为整体读取。
 */
export function readTags(absPath: string): AudioTag {
  const MAX_HEAD = 8 << 20;
  let fd: number | undefined;
  try {
    fd = fs.openSync(absPath, 'r');
    const size = fs.fstatSync(fd).size;
    const headLen = Math.min(size, MAX_HEAD);
    const head = Buffer.alloc(headLen);
    if (headLen > 0) fs.readSync(fd, head, 0, headLen, 0);

    if (headLen >= 8 && head.toString('latin1', 4, 8) === 'ftyp') {
      const whole = Buffer.alloc(size);
      fs.readSync(fd, whole, 0, size, 0);
      return parseM4a(whole, absPath).tag;
    }

    const v2 = parseId3v2(head);
    if (v2 && (v2.tag.title || v2.tag.artist || v2.tag.album)) return v2.tag;

    // ID3v1 位于文件末尾 128 字节，必须单独读，不能用头部缓冲区
    let v1: { size: number; tag: AudioTag } | null = null;
    if (size >= 128) {
      const tail = Buffer.alloc(128);
      fs.readSync(fd, tail, 0, 128, size - 128);
      v1 = parseId3v1(tail);
    }
    return mergeTags(v2?.tag, v1?.tag);
  } catch {
    return {};
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

// ---------------------------------------------------------------- 展示辅助

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '--:--';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
  return h > 0
    ? `${h}:${mm}:${String(s).padStart(2, '0')}`
    : `${mm}:${String(s).padStart(2, '0')}`;
}
