/**
 * 文件系统安全工具：原子写入、强制刷盘、备份、受控删除。
 *
 * 设计约束（来自真实设备踩坑）：
 *  - FAT32 有写缓存，写完不刷盘就拔线，设备看到的还是旧数据库 → 每次写入后 fsync。
 *  - 设备上的文件只允许在 `iPod_Control/Music/` 与 `iPod_Control/Speakable/Tracks/` 下增删，
 *    其余路径一律拒绝（`assertInside`）。
 *  - 任何破坏性操作前先备份。
 */
import * as fs from 'fs';
import * as path from 'path';

export const COPY_CHUNK = 1 << 20; // 1 MiB

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/** 把 Windows 路径统一成 `/` 分隔，便于与设备内路径比较 */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * 断言目标路径位于允许的根目录之内（防目录穿越）。
 * 用于所有删除/覆盖操作之前的最后一道闸。
 */
export function assertInside(child: string, root: string): void {
  const c = toPosix(path.resolve(child));
  const r = toPosix(path.resolve(root)).replace(/\/+$/, '');
  if (c !== r && !c.startsWith(`${r}/`)) {
    throw new Error(`路径越界，已拒绝操作：${c} 不在 ${r} 之内`);
  }
}

/**
 * 原子写入：先写同目录临时文件并刷盘，再 rename 覆盖。
 * 这样即使中途断电，原文件也不会变成半截垃圾。
 */
export function atomicWriteFile(file: string, data: Buffer): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data, 0, data.length, 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  flushFile(file);
}

/** 对单个文件句柄执行 FlushFileBuffers */
export function flushFile(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r+');
    fs.fsyncSync(fd);
    return true;
  } catch {
    return false;
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

/**
 * 卷级刷盘。FAT32 的目录项属于元数据，文件级 fsync 不一定覆盖，
 * 因此能刷则刷。需要管理员权限，失败时静默降级（用户仍应"安全弹出"）。
 */
export function flushVolume(driveLetter: string): boolean {
  const dev = `\\\\.\\${driveLetter.replace(/:$/, '')}:`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(dev, 'r+');
    fs.fsyncSync(fd);
    return true;
  } catch {
    return false;
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

/** 带进度回调的复制，并在结束时 fsync */
export function copyFileSync(
  src: string,
  dst: string,
  onProgress?: (copied: number, total: number) => void,
): number {
  const total = fs.statSync(src).size;
  ensureDir(path.dirname(dst));
  const rfd = fs.openSync(src, 'r');
  const wfd = fs.openSync(dst, 'w');
  const buf = Buffer.allocUnsafe(COPY_CHUNK);
  let copied = 0;
  try {
    for (;;) {
      const n = fs.readSync(rfd, buf, 0, COPY_CHUNK, copied);
      if (n <= 0) break;
      fs.writeSync(wfd, buf, 0, n, copied);
      copied += n;
      onProgress?.(copied, total);
    }
    fs.fsyncSync(wfd);
  } finally {
    fs.closeSync(rfd);
    fs.closeSync(wfd);
  }
  return copied;
}

/** 受控删除：先确认路径合法，再卸载只读属性后删除 */
export function removeFileSafe(file: string, allowedRoot: string): void {
  assertInside(file, allowedRoot);
  if (!exists(file)) return;
  try {
    fs.chmodSync(file, 0o666);
  } catch {
    /* 忽略：FAT32 上通常无效 */
  }
  fs.unlinkSync(file);
}

/**
 * 备份单个文件到 `backups/<时间戳>-<标签>/<相对路径扁平化>`。
 * 备份失败不阻断主流程，但会把原因带回给调用方展示。
 */
export function backupFile(
  file: string,
  backupsRoot: string,
  label: string,
  relHint?: string,
): string {
  const ts = timestamp();
  const dir = path.join(backupsRoot, `${ts}-${label}`);
  ensureDir(dir);
  const flat = (relHint ?? path.basename(file)).replace(/[\\/]/g, '__');
  const dst = path.join(dir, flat);
  fs.copyFileSync(file, dst);
  flushFile(dst);
  return dst;
}

export function timestamp(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** 目录占用（递归累计文件大小） */
export function dirSize(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirSize(p);
      else total += fs.statSync(p).size;
    } catch {
      /* ignore */
    }
  }
  return total;
}
