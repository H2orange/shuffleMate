/**
 * iPod 设备发现与曲库装载。
 *
 * 唯一真相来源是设备上的 `iPod_Control/Music/` 目录；
 * `iTunesSD` 只是索引，每次增删后整体重建（见 sync.ts）。
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { readTags } from './audio';
import { toPosix } from './fsx';
import { parseSd } from './itunessd';
import { readItunesDb } from './itunesdb';
import { DeviceInfo, SdModel, TrackView } from './types';
import { speakableDirs, voiceFilename } from './voiceover';

const IPOD_SD_REL = 'iPod_Control/iTunes/iTunesSD';
const MUSIC_REL = 'iPod_Control/Music';

// ---------------------------------------------------------------- 设备发现

/** 扫描所有盘符，返回含 iTunesSD 的设备根路径（形如 `F:/`） */
export function findIpodRoots(): string[] {
  const out: string[] = [];
  for (let c = 65; c <= 90; c++) {
    const letter = String.fromCharCode(c);
    const root = `${letter}:/`;
    try {
      if (fs.existsSync(path.join(root, IPOD_SD_REL))) out.push(root);
    } catch {
      /* 盘符不存在 */
    }
  }
  return out;
}

export function findFirstIpod(): string | null {
  return findIpodRoots()[0] ?? null;
}

function volumeLabel(root: string): string {
  const letter = root.replace(/:.*$/, '');
  try {
    const script = `[Console]::Out.Write((Get-Volume -DriveLetter ${letter.replace(/'/g, '')} -ErrorAction Stop).FileSystemLabel)`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const wsRoot = process.env.SystemRoot || 'C:\\Windows';
    const ps = path.join(wsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return execFileSync(
      ps,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
    ).trim();
  } catch {
    return '';
  }
}

function diskUsage(root: string): { total: number; free: number } {
  try {
    const s = fs.statfsSync(root);
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {
    return { total: 0, free: 0 };
  }
}

/** 扫描 `Music/F*` 下的实际音频文件，键为 iPod 相对路径（无前导 `/`） */
export function scanMusicFiles(root: string): Map<string, { absPath: string; size: number }> {
  const out = new Map<string, { absPath: string; size: number }>();
  const musicDir = path.join(root, MUSIC_REL);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(musicDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(musicDir, e.name);
    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || f.name.startsWith('.')) continue;
      const absPath = path.join(dir, f.name);
      let size = 0;
      try {
        size = fs.statSync(absPath).size;
      } catch {
        continue;
      }
      out.set(toPosix(path.join(MUSIC_REL, e.name, f.name)), { absPath, size });
    }
  }
  return out;
}

export function readModel(root: string): SdModel {
  const data = fs.readFileSync(path.join(root, IPOD_SD_REL));
  return parseSd(data);
}

export interface LoadedLibrary {
  model: SdModel;
  tracks: TrackView[];
  /** 设备 `Music/` 下实际存在的文件 */
  files: Map<string, { absPath: string; size: number }>;
  /** 数据库里有、但文件已丢失的条目数 */
  missingFiles: number;
  /** 文件存在、但数据库里没有的孤儿文件数 */
  orphanFiles: number;
}

/**
 * 装载设备曲库。
 *
 * 标题解析采用三级回退：**ID3 标签 → iTunesDB 标题 → 文件名**。
 * 中间那级不可省略 —— 实测本机 13 首六级听力 MP3 全部没有标题标签，
 * 歌名只存在于 iTunesDB；少了它，界面上只能看到 `SBJT`、`DQNL` 这种随机名。
 */
export function loadLibrary(root: string, readTagData = true): LoadedLibrary {
  const model = readModel(root);
  const files = scanMusicFiles(root);
  const db = readItunesDb(root);

  let voiceFiles: Set<string>;
  try {
    voiceFiles = new Set(
      fs.readdirSync(speakableDirs(root).tracks).map((f) => f.toLowerCase()),
    );
  } catch {
    voiceFiles = new Set();
  }

  const known = new Set<string>();
  let missing = 0;

  const tracks: TrackView[] = model.tracks.map((t) => {
    const rel = t.filename.replace(/^\/+/, '');
    known.add(rel);
    const file = files.get(rel);
    if (!file) missing++;

    const dbEntry = db.get(rel);
    const stem = path.basename(rel).replace(/\.[^.]+$/, '');
    const tag = file && readTagData ? readTags(file.absPath) : {};

    const title = tag.title || dbEntry?.title || stem;
    const artist = tag.artist || dbEntry?.artist || '';
    const album = tag.album || dbEntry?.album || '';
    const source: TrackView['source'] = tag.title
      ? 'id3'
      : dbEntry?.title
        ? 'itunesdb'
        : 'filename';

    return {
      id: t.dbid.toString('hex'),
      filename: rel,
      title,
      artist,
      album,
      durationMs: t.stopMs,
      fileSize: file?.size ?? 0,
      format: t.filetype === 2 ? 'AAC' : 'MP3',
      source,
      exists: !!file,
      hasVoiceover: voiceFiles.has(voiceFilename(t.dbid).toLowerCase()),
    };
  });

  return {
    model,
    tracks,
    files,
    missingFiles: missing,
    orphanFiles: [...files.keys()].filter((k) => !known.has(k)).length,
  };
}

export function getDeviceInfo(root: string): DeviceInfo {
  const { total, free } = diskUsage(root);
  const files = scanMusicFiles(root);
  let used = 0;
  for (const f of files.values()) used += f.size;

  let model: SdModel | null = null;
  try {
    model = readModel(root);
  } catch {
    model = null;
  }

  return {
    root,
    driveLetter: root.replace(/:.*$/, ':'),
    volumeLabel: volumeLabel(root),
    totalBytes: total,
    freeBytes: free,
    trackCount: model?.tracks.length ?? 0,
    fileCount: files.size,
    usedByMusicBytes: used,
    voiceoverSupported: fs.existsSync(speakableDirs(root).tracks),
    voiceoverEnabled: !!model?.root.voiceover,
    version: model?.root.version ?? 0,
  };
}
