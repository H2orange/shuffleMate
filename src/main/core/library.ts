/**
 * 本地曲库：扫描与预检。
 *
 * 只在「导入」时用到。预检阶段就解析标签与时长，这样：
 *  - 不支持的格式在**写入设备之前**就被拦下（不会留下播不出来的死条目）；
 *  - 界面能在导入前显示曲名、时长、容量占用。
 */
import * as fs from 'fs';
import * as path from 'path';
import { probeAudioFile, UnsupportedFormatError } from './audio';
import { LocalTrack } from './types';

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.mp4', '.aac']);

export function isAudioFile(p: string): boolean {
  return AUDIO_EXT.has(path.extname(p).toLowerCase());
}

/** 递归收集目录下的音频文件 */
export function listAudioFiles(dir: string, recursive = true): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (recursive) out.push(...listAudioFiles(p, true));
    } else if (e.isFile() && isAudioFile(p)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * 把「用户给出的路径」展开成待导入清单。
 * 目录会被递归展开；非音频文件被静默忽略。
 */
export function expandInputs(inputs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (p: string) => {
    const key = p.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };
  for (const raw of inputs) {
    let st: fs.Stats;
    try {
      st = fs.statSync(raw);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      for (const f of listAudioFiles(raw)) push(f);
    } else if (isAudioFile(raw)) {
      push(raw);
    }
  }
  return out;
}

/** 解析单个本地文件为待导入曲目；失败时带上原因而不是抛错 */
export function inspectLocalFile(absPath: string): LocalTrack {
  const fileName = path.basename(absPath);
  const stem = fileName.replace(/\.[^.]+$/, '');
  const base: LocalTrack = {
    path: absPath,
    fileName,
    fileSize: 0,
    title: stem,
    artist: '',
    album: '',
    durationMs: 0,
    format: path.extname(absPath).slice(1).toUpperCase(),
  };
  try {
    base.fileSize = fs.statSync(absPath).size;
  } catch (e) {
    return { ...base, error: `无法读取文件：${(e as Error).message}` };
  }
  try {
    const info = probeAudioFile(absPath);
    return {
      ...base,
      title: info.tag.title || stem,
      artist: info.tag.artist ?? '',
      album: info.tag.album ?? '',
      durationMs: info.durationMs,
      format: info.container === 'm4a' ? 'AAC' : 'MP3',
    };
  } catch (e) {
    const msg = e instanceof UnsupportedFormatError ? e.message : `解析失败：${(e as Error).message}`;
    return { ...base, error: msg };
  }
}

/** 批量解析（保持输入顺序） */
export function inspectLocalFiles(paths: string[]): LocalTrack[] {
  return paths.map(inspectLocalFile);
}
