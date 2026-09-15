/**
 * iTunesDB 只读解析 —— 仅用于**取回标题等文本元数据**。
 *
 * 为什么需要它：实测本机 13 个 MP3 中有 4 个完全没有 ID3 标签、其余也没有标题字段，
 * 歌名只存在于 iTunesDB 里。若不做这层回退，界面上只能显示 `SBJT` 这类随机文件名
 * ——正是本工具要解决的问题。
 *
 * 重要：shuffle 播放**不读**这个文件，因此本模块**只读、永不写入**。
 */
import * as fs from 'fs';
import * as path from 'path';

export interface DbEntry {
  title: string;
  album: string;
  artist: string;
  genre: string;
}

/** mhod 类型编号 → 字段名 */
const MHOD_TITLE = 1;
const MHOD_PATH = 2;
const MHOD_ALBUM = 3;
const MHOD_ARTIST = 4;
const MHOD_GENRE = 5;

/**
 * 读取 iTunesDB，返回 `路径 → 元数据` 的映射。
 *
 * 键为「去掉前导 `/` 的 iPod 相对路径」（如 `iPod_Control/Music/F00/SBJT.mp3`），
 * 以便与 iTunesSD 中的 `filename` 字段对齐。
 *
 * 任何结构性异常都只返回空映射，不抛错 —— 元数据回退是「锦上添花」，
 * 不能因为 iTunesDB 损坏就阻断整个流程。
 */
export function readItunesDb(ipodRoot: string): Map<string, DbEntry> {
  const out = new Map<string, DbEntry>();
  const file = path.join(ipodRoot, 'iPod_Control', 'iTunes', 'iTunesDB');
  let db: Buffer;
  try {
    db = fs.readFileSync(file);
  } catch {
    return out;
  }

  try {
    const i = db.indexOf('mhlt');
    if (i < 0) return out;
    const hl = db.readUInt32LE(i + 4);
    const n = db.readUInt32LE(i + 8);

    let q = i + hl;
    for (let t = 0; t < n; t++) {
      if (q + 16 > db.length || db.toString('latin1', q, q + 4) !== 'mhit') break;
      const mhitHeaderLen = db.readUInt32LE(q + 4);
      const mhitTotalLen = db.readUInt32LE(q + 8);
      const nHod = db.readUInt32LE(q + 12);

      const fields = new Map<number, string>();
      let c = q + mhitHeaderLen;
      for (let h = 0; h < nHod; h++) {
        if (c + 16 > db.length || db.toString('latin1', c, c + 4) !== 'mhod') break;
        const hodHeaderLen = db.readUInt32LE(c + 4);
        const hodTotalLen = db.readUInt32LE(c + 8);
        if (hodTotalLen <= 0) break;
        const type = db.readUInt32LE(c + 12);
        const strLenAt = c + hodHeaderLen + 4;
        const dataAt = c + hodHeaderLen + 16;
        if (strLenAt + 4 <= db.length && dataAt <= db.length) {
          const strLen = db.readUInt32LE(strLenAt);
          const end = Math.min(dataAt + strLen, db.length);
          if (end > dataAt) {
            fields.set(type, db.toString('utf16le', dataAt, end));
          }
        }
        c += hodTotalLen;
      }

      // iTunesDB 的路径用 ':' 分隔（iTunesSD 用 '/'）
      const rawPath = (fields.get(MHOD_PATH) ?? '').replace(/:/g, '/');
      if (rawPath) {
        out.set(rawPath.replace(/^\/+/, ''), {
          title: fields.get(MHOD_TITLE) ?? '',
          album: fields.get(MHOD_ALBUM) ?? '',
          artist: fields.get(MHOD_ARTIST) ?? '',
          genre: fields.get(MHOD_GENRE) ?? '',
        });
      }
      if (mhitTotalLen <= 0) break;
      q += mhitTotalLen;
    }
  } catch {
    // 结构损坏：返回已解析到的部分
  }
  return out;
}
