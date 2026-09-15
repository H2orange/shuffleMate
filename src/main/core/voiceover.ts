/**
 * VoiceOver 语音生成（Node 侧实现）。
 *
 * 已实机验证的三条规则
 * --------------------
 * 1. 目录：`iPod_Control/Speakable/Tracks/`（**Speakable 在 iPod_Control 之内**，
 *    不在 iPod 根目录 —— 这里曾经写错过一次，注意）。
 * 2. 文件名 = 曲目 `dbid`（8 字节）**逐字节倒序**后的十六进制大写 + `.wav`。
 *    例：dbid `5c da 28 4d 1d 1a 10 83` → `83101A1D4D28DA5C.wav`。
 *    设备上 13 首 **13/13 全命中**。
 * 3. 总开关是 iTunesSD 根头第 0x1D 字节（**全局**，非逐曲）。置 0 会整机静音。
 *
 * WAV 容器（已逐字节比对，13 个 Apple 文件完全一致）
 * -------------------------------------------------
 *   [0:4]       "RIFF"
 *   [4:8]       文件总长 − 8
 *   [8:12]      "WAVE"
 *   [12:16]     "fmt " + 长度 16 + 16 字节 PCM 描述
 *   [36:40]     "FLLR" + 长度 4044（全零填充）
 *   [4088:4092] "data" + PCM 长度
 *   [4096:]     PCM 数据
 *   → 头部固定 4096 字节；格式 22050 Hz / 16 bit / 单声道 PCM。
 *
 *   Windows SAPI / System.Speech 直接输出的是 44~46 字节紧凑头，**容器不同**。
 *   本模块统一重打包为上面的 Apple 容器，消除格式兼容性猜测。
 */
import { execFileSync, execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ensureDir, exists, flushFile, toPosix } from './fsx';

/** Apple VoiceOver WAV 的固定头部长度 */
export const APPLE_HEADER_LEN = 4096;
/** 与设备上 Apple 文件完全一致的默认采样率 */
export const DEFAULT_RATE = 22050;

/**
 * 读取配置类环境变量：新名 `SHUFFLEMATE_*` 优先，旧名 `IPODTOOLS_*` 兜底。
 *
 * 项目 2026-09-15 改名为 ShuffleMate（原名「iPod 音乐管家」/ ipodTools），
 * 但用户机器上可能已经设过 `IPODTOOLS_PYTHON` 之类的变量。保留旧名兜底，
 * 改名就不会打断任何人既有的配置。
 */
function envCompat(suffix: 'PYTHON' | 'TTS'): string | undefined {
  return process.env[`SHUFFLEMATE_${suffix}`] ?? process.env[`IPODTOOLS_${suffix}`];
}

/** 支持的采样率（System.Speech 单声道 16 位） */
const SUPPORTED_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

/** 中文语音优先级 */
const PREFERRED_VOICES = [
  'Microsoft Huihui Desktop',
  'Microsoft Xiaoxiao',
  'Microsoft Yaoyao',
  'Microsoft Kangkang',
  'Microsoft HuiHui',
];

// ---------------------------------------------------------------- 命名规则

/** dbid(8B) → VoiceOver WAV 文件名（倒序十六进制大写） */
export function voiceFilename(dbid: Buffer): string {
  const rev = Buffer.from(dbid.subarray(0, 8)).reverse();
  return `${rev.toString('hex').toUpperCase()}.wav`;
}

/**
 * 播报文本 → dbid。
 *
 * 用 md5 派生而非随机值，好处是**幂等**：同一首歌重复导入得到同一个 dbid，
 * 语音文件天然复用，不需要额外的去重表。
 * （实测 Apple 自己的 dbid 不是任何可推导哈希，因此 dbid 只是不透明标识符，
 * 我们自定义确定性方案完全合法。）
 */
export function dbidFromText(text: string): Buffer {
  return crypto.createHash('md5').update(text, 'utf8').digest().subarray(0, 8);
}

/** 在一批文本中分配互不冲突的 dbid（同曲名重复导入时追加序号） */
export function uniqueDbids(texts: string[]): Buffer[] {
  const seen = new Map<string, number>();
  return texts.map((t) => {
    const n = seen.get(t) ?? 0;
    seen.set(t, n + 1);
    return dbidFromText(n === 0 ? t : `${t}\u001f#${n + 1}`);
  });
}

/** 拼装播报文本：标题优先，有艺术家则追加 */
export function announceText(title: string, artist?: string): string {
  const parts = [title, artist].map((s) => (s ?? '').trim()).filter(Boolean);
  return parts.join(' - ');
}

// ---------------------------------------------------------------- WAV 解析 / 封装

export interface WavInfo {
  fileSize: number;
  audioFormat: number;
  channels: number;
  rate: number;
  bits: number;
  byteRate: number;
  blockAlign: number;
  dataOffset: number;
  dataSize: number;
  duration: number;
  pcm: boolean;
  isAppleContainer: boolean;
  raw: Buffer;
}

export function parseWav(input: Buffer | string): WavInfo | null {
  const d = typeof input === 'string' ? fs.readFileSync(input) : input;
  if (d.length < 44 || d.toString('latin1', 0, 4) !== 'RIFF' || d.toString('latin1', 8, 12) !== 'WAVE') {
    return null;
  }
  let i = 12;
  let fmt: Omit<WavInfo, 'fileSize' | 'dataOffset' | 'dataSize' | 'duration' | 'isAppleContainer' | 'raw'> | null = null;
  let dataOffset = -1;
  let dataSize = 0;
  while (i + 8 <= d.length) {
    const cid = d.toString('latin1', i, i + 4);
    const sz = d.readUInt32LE(i + 4);
    if (cid === 'fmt ' && i + 24 <= d.length) {
      fmt = {
        audioFormat: d.readUInt16LE(i + 8),
        channels: d.readUInt16LE(i + 10),
        rate: d.readUInt32LE(i + 12),
        byteRate: d.readUInt32LE(i + 16),
        blockAlign: d.readUInt16LE(i + 20),
        bits: d.readUInt16LE(i + 22),
        pcm: d.readUInt16LE(i + 8) === 1,
      };
    } else if (cid === 'data') {
      dataOffset = i + 8;
      dataSize = sz;
      break;
    }
    i += 8 + sz + (sz & 1);
  }
  if (!fmt || dataOffset < 0) return null;
  return {
    ...fmt,
    fileSize: d.length,
    dataOffset,
    dataSize,
    duration: fmt.byteRate > 0 ? dataSize / fmt.byteRate : 0,
    isAppleContainer: dataOffset === APPLE_HEADER_LEN,
    raw: d,
  };
}

/** 把裸 PCM 包装成 Apple VoiceOver WAV 容器（固定 4096 字节头） */
export function buildAppleWav(pcm: Buffer, rate = DEFAULT_RATE, channels = 1, bits = 16): Buffer {
  const blockAlign = (channels * bits) / 8;
  const byteRate = rate * blockAlign;
  const header = Buffer.alloc(APPLE_HEADER_LEN);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(APPLE_HEADER_LEN + pcm.length - 8, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write('FLLR', 36, 'latin1');
  header.writeUInt32LE(APPLE_HEADER_LEN - 52, 40); // 4044
  // [44:4088] 保持全零填充
  header.write('data', 4088, 'latin1');
  header.writeUInt32LE(pcm.length, 4092);
  return Buffer.concat([header, pcm]);
}

/**
 * 把任意单声道 16 位 PCM WAV 转为 Apple 容器。
 * 返回的 `info` 描述的是**重打包后的产物**（头部 4096），不是源文件。
 */
export function repackToApple(src: Buffer | string): { data: Buffer; info: WavInfo } {
  const i = parseWav(src);
  if (!i) throw new Error('不是有效的 RIFF/WAVE');
  if (!i.pcm) throw new Error(`仅支持 PCM，当前 audioFormat=${i.audioFormat}`);
  if (i.channels !== 1 || i.bits !== 16) {
    throw new Error(`仅支持单声道 16 位，当前 ${i.channels}ch/${i.bits}bit`);
  }
  const pcm = i.raw.subarray(i.dataOffset, i.dataOffset + i.dataSize);
  const data = buildAppleWav(pcm, i.rate, i.channels, i.bits);
  const info = parseWav(data);
  if (!info) throw new Error('重打包后的 WAV 无法解析（内部错误）');
  return { data, info };
}

// ---------------------------------------------------------------- TTS（Windows SAPI）

export interface VoiceInfo {
  name: string;
  culture: string;
  gender: string;
}

/**
 * 解析可用的 PowerShell 解释器。
 *
 * **必须用绝对路径**：在 nvm4w 环境下，Electron 派生的子进程会丢失 System32 路径，
 * 直接 spawn `powershell.exe` 会 ENOENT。
 *
 * 优先 Windows PowerShell（自带 .NET Framework 的 System.Speech），
 * 找不到时退回 PowerShell 7（pwsh）。
 */
export function powershellPath(): string {
  const candidates: string[] = [];
  const root = process.env.SystemRoot || 'C:\\Windows';
  candidates.push(path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (base) candidates.push(path.join(base, 'PowerShell', '7', 'pwsh.exe'));
  }
  for (const c of candidates) {
    if (exists(c)) return c;
  }
  // 都不在：返回首选路径，让错误信息指向正确的位置
  return candidates[0];
}

/** 语音子系统的诊断信息，用于在界面/日志里说明"为什么没声音" */
export interface TtsDiagnostics {
  /** 实际生效的后端；null = 没有可用后端 */
  backend: TtsBackendName | null;
  powershell: string;
  powershellFound: boolean;
  python: string | null;
  voices: VoiceInfo[];
  error: string | null;
}

export function ttsDiagnostics(): TtsDiagnostics {
  const interpreter = powershellPath();
  const found = exists(interpreter);
  const backend = resolveBackend(true);
  if (!backend) {
    return {
      backend: null,
      powershell: interpreter,
      powershellFound: found,
      python: null,
      voices: [],
      error: found
        ? 'PowerShell 无法启动，且未检测到带 pywin32 的 Python。语音功能不可用，音乐增删不受影响。'
        : `找不到 PowerShell 解释器：${interpreter}，且未检测到带 pywin32 的 Python。`,
    };
  }
  try {
    return {
      backend: backend.name,
      powershell: interpreter,
      powershellFound: found,
      python: backend.name === 'python' ? backend.exe : null,
      voices: listVoices(),
      error: null,
    };
  } catch (e) {
    return {
      backend: backend.name,
      powershell: interpreter,
      powershellFound: found,
      python: backend.name === 'python' ? backend.exe : null,
      voices: [],
      error: (e as Error).message,
    };
  }
}

/** PowerShell 单引号字符串字面量 */
function psq(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * 通过 `-EncodedCommand`（UTF-16LE Base64）执行脚本。
 *
 * 这样命令行上**只有 ASCII**：不产生 .ps1 临时文件、不受控制台代码页影响、
 * 中文文本也不会在参数传递中被破坏。
 */
/**
 * 给子进程准备一份干净的环境变量。
 *
 * `NODE_OPTIONS` 里常被各种工具注入 `--require` 钩子（例如某些 IDE / CLI 的
 * 语言运行时垫片），这些钩子可能拦截子进程创建，导致 PowerShell 直接 EPERM。
 * PowerShell 本身不需要这些变量，剥掉更稳。
 */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/** 把子进程错误翻译成用户能看懂的话 */
function describeSpawnError(err: NodeJS.ErrnoException, stderr: string): string {
  const code = (err as { code?: string }).code;
  if (code === 'ENOENT') {
    return `找不到 PowerShell 解释器（${powershellPath()}）。中文语音需要 Windows 内置的 System.Speech。`;
  }
  if (code === 'EPERM' || code === 'EACCES') {
    return (
      `无权启动 PowerShell（${code}）。可能是安全软件或策略拦截了子进程创建。` +
      `语音功能因此不可用，但音乐增删不受影响。`
    );
  }
  const detail = (stderr || err.message || '').trim();
  return `PowerShell 执行失败${code ? `（${code}）` : ''}：${detail.slice(0, 400)}`;
}

function runPowerShell(script: string): string {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  try {
    return execFileSync(
      powershellPath(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { encoding: 'utf8', windowsHide: true, timeout: 60_000, env: childEnv() },
    );
  } catch (e) {
    throw new Error(describeSpawnError(e as NodeJS.ErrnoException, String((e as { stderr?: string }).stderr ?? '')));
  }
}

function runPowerShellAsync(script: string): Promise<string> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      powershellPath(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { encoding: 'utf8', windowsHide: true, timeout: 60_000, env: childEnv() },
      (err, stdout, stderr) => {
        if (err) reject(new Error(describeSpawnError(err as NodeJS.ErrnoException, stderr)));
        else resolve(stdout);
      },
    );
  });
}

/** 通过 PowerShell 枚举 SAPI 语音（PowerShell 不可用时抛错） */
export function listVoicesPowerShell(): VoiceInfo[] {
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    'foreach ($v in $s.GetInstalledVoices()) {',
    '  if (-not $v.Enabled) { continue }',
    '  $i = $v.VoiceInfo',
    "  [Console]::Out.WriteLine($i.Name + '|' + $i.Culture.Name + '|' + $i.Gender)",
    '}',
    '$s.Dispose()',
  ].join('\n');
  const out = runPowerShell(script);
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name, culture, gender] = l.split('|');
      return { name, culture, gender };
    });
}

/** 枚举可用语音：优先 PowerShell，失败时退回 Python 后端 */
export function listVoices(): VoiceInfo[] {
  try {
    return listVoicesPowerShell();
  } catch (e) {
    const py = pythonHasWin32();
    if (!py) throw e;
    return listVoicesViaPython(py);
  }
}

/** 优选中文语音；找不到中文则退回第一个可用语音 */
export function pickVoice(prefer?: string | null): string | null {
  let voices: VoiceInfo[];
  try {
    voices = listVoices();
  } catch {
    return prefer ?? null;
  }
  if (voices.length === 0) return prefer ?? null;
  const names = voices.map((v) => v.name);
  if (prefer && names.includes(prefer)) return prefer;
  for (const p of PREFERRED_VOICES) {
    const hit = names.find((n) => n.toLowerCase() === p.toLowerCase());
    if (hit) return hit;
  }
  const zh = voices.find((v) => /^zh/i.test(v.culture) || /huihui|xiaoxiao|yaoyao|kangkang|huihui/i.test(v.name));
  return zh ? zh.name : voices[0].name;
}

export interface SynthOptions {
  rate?: number;
  voice?: string | null;
  /** SAPI 语速 -10..10 */
  speed?: number;
}

export interface SynthResult {
  /** 已经过 Apple 容器重打包的完整 WAV 字节 */
  data: Buffer;
  info: WavInfo;
  /** 实际生效的后端 */
  backend: TtsBackendName;
}

/**
 * 合成语音并**直接返回 Apple 容器格式的 WAV 字节**。
 *
 * 流程：后端输出到临时 WAV → 读回 → 重打包为 Apple 4096 字节容器 → 由调用方原子写入。
 * 后端按 PowerShell → Python 的顺序自动选择（见 resolveBackend）。
 */
export async function synthesize(text: string, opts: SynthOptions = {}): Promise<SynthResult> {
  const rate = opts.rate ?? DEFAULT_RATE;
  if (!SUPPORTED_RATES.includes(rate)) {
    throw new Error(`不支持采样率 ${rate}，可选 ${SUPPORTED_RATES.join('/')}`);
  }
  const backend = resolveBackend();
  if (!backend) {
    throw new Error(
      '找不到可用的语音合成后端：PowerShell 无法启动，且未检测到带 pywin32 的 Python。' +
        '设置环境变量 SHUFFLEMATE_TTS=python 可强制使用 Python 后端。',
    );
  }
  const speed = Math.max(-10, Math.min(10, opts.speed ?? 0));

  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ipodvo-'));
  const raw = path.join(tmpDir, 'raw.wav');
  try {
    if (backend.name === 'powershell') {
      const voice = opts.voice ?? pickVoice();
      const script = [
        "$ErrorActionPreference='Stop'",
        'Add-Type -AssemblyName System.Speech',
        `$text=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psq(
          Buffer.from(text, 'utf8').toString('base64'),
        )}))`,
        '$s=New-Object System.Speech.Synthesis.SpeechSynthesizer',
        `$fmt=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(${rate},[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono)`,
        voice ? `$s.SelectVoice(${psq(voice)})` : '',
        `$s.Rate=${speed}`,
        '$s.Volume=100',
        `$s.SetOutputToWaveFile(${psq(raw)}, $fmt)`,
        'try { $s.Speak($text) } finally { $s.Dispose() }',
        "[Console]::Out.WriteLine('OK')",
      ]
        .filter(Boolean)
        .join('\n');
      await runPowerShellAsync(script);
    } else {
      synthViaPython(backend.exe, text, raw, rate, opts.voice ?? null);
    }

    if (!exists(raw)) throw new Error(`${backend.name} 后端未生成输出文件`);
    const repacked = repackToApple(raw);
    return { ...repacked, backend: backend.name };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------- 后端选择

export type TtsBackendName = 'powershell' | 'python';

interface ResolvedBackend {
  name: TtsBackendName;
  exe: string;
}

/**
 * 语音合成后端的探测顺序。
 *
 * 首选 Windows PowerShell（System.Speech）——不需要任何第三方依赖，
 * 且能精确控制输出为 22050 Hz / 单声道 / 16 位。
 *
 * 但实测存在**PowerShell 被安全策略拦截**的环境（本机即命中：
 * 直接启动返回 WinError 5「拒绝访问」，而 cmd.exe / python.exe 一切正常）。
 * 由于语音只影响播报、不应阻断音乐管理，这里补一条 Python + pywin32 的后备路径
 * —— 它能通过 SAPI COM 产出与 PowerShell 完全同构的 WAV。
 *
 * 想强制指定后端时设置环境变量 `SHUFFLEMATE_TTS=python|powershell`。
 */
let backendCache: ResolvedBackend | null | undefined;

/**
 * 扫描 `<parent>\Python3xx\python.exe`（官网安装包的标准布局），版本号大的优先。
 */
function scanVersionedInstalls(parent?: string): string[] {
  if (!parent) return [];
  let names: string[];
  try {
    names = fs.readdirSync(parent);
  } catch {
    return [];
  }
  return names
    .filter((n) => /^Python3\d+$/i.test(n))
    .sort((a, b) => parseInt(b.replace(/\D/g, ''), 10) - parseInt(a.replace(/\D/g, ''), 10))
    .map((n) => path.join(parent, n, 'python.exe'));
}

/**
 * 列出候选解释器可直接查到的 site-packages 目录。
 *
 * 用来**免启动**地筛掉没装 pywin32 的解释器：逐个 spawn 一遍 Python 去做
 * `import win32com.client` 要 100 ms 量级，候选一多就要好几秒。
 */
function sitePackagesDirs(pyExe: string): string[] {
  const exeDir = path.dirname(pyExe);
  const base = path.basename(exeDir).toLowerCase();
  // venv / conda-env：解释器在 Scripts\（Windows）或 bin\，site-packages 在上一级
  const roots =
    base === 'scripts' || base === 'bin' ? [path.join(exeDir, '..')] : [exeDir];
  return roots.map((r) => path.normalize(path.join(r, 'Lib', 'site-packages')));
}

/** 粗判该解释器是否装了 pywin32（只看目录，不启动进程） */
function likelyHasWin32Com(pyExe: string): boolean {
  return sitePackagesDirs(pyExe).some((d) => exists(path.join(d, 'win32com')));
}

/**
 * 候选 Python 解释器。
 *
 * 顺序 = 命中概率从高到低。`pythonHasWin32()` 会依次实测，所以排在前面的
 * 先被验证。**之所以要扫这么多位置**：语音合成在 PowerShell 被安全策略拦截的
 * 机器上只能靠 Python + pywin32（实测本机即命中），而这类机器上「哪个 Python
 * 装了 pywin32」完全不可预期 —— 官网安装包、conda、各类 IDE / 自动化工具链
 * 自带的隔离环境都可能成为唯一可用的那个。
 *
 * 显式指定优先：环境变量 `SHUFFLEMATE_PYTHON` 指向的 `python.exe` 永远第一个试。
 */
function pythonCandidates(): string[] {
  const all: string[] = [];
  const push = (p?: string) => {
    if (p && exists(p) && !all.includes(p)) all.push(p);
  };

  // 1) 用户显式指定
  push(envCompat('PYTHON'));

  // 2) PATH 上的
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir || dir.length < 3) continue;
    push(path.join(dir, 'python.exe'));
    push(path.join(dir, 'python3.exe'));
  }

  const la = process.env.LOCALAPPDATA;
  const pf = process.env.ProgramFiles;
  const pfx86 = process.env['ProgramFiles(x86)'];
  const pd = process.env.ProgramData;
  const up = process.env.USERPROFILE;

  // 3) 官网安装包（含多版本共存）
  for (const p of [la && path.join(la, 'Programs', 'Python'), 'C:\\', pf, pfx86]) {
    scanVersionedInstalls(p).forEach(push);
  }
  // 兼容早期只认 Python311 的写法（LOCALAPPDATA 缺失时仍能兜住）
  if (la) push(path.join(la, 'Programs', 'Python', 'Python311', 'python.exe'));

  // 4) conda / miniconda / scoop
  for (const base of [la, up, pd, pf]) {
    if (!base) continue;
    for (const name of ['miniconda3', 'anaconda3', 'Miniconda3', 'Anaconda3']) {
      push(path.join(base, name, 'python.exe'));
      push(path.join(base, name, 'Scripts', 'python.exe'));
    }
  }
  if (up) push(path.join(up, 'scoop', 'apps', 'python', 'current', 'python.exe'));

  // 5) 自动化 / IDE 工具链自带的隔离环境（本机 WorkBuddy 即属于这一类：
  //    系统 Python 没有 pywin32，能用的解释器只在工具链的 venv 里）
  if (up) {
    const wb = path.join(up, '.workbuddy', 'binaries', 'python');
    try {
      fs.readdirSync(path.join(wb, 'envs')).forEach((n) =>
        push(path.join(wb, 'envs', n, 'Scripts', 'python.exe')),
      );
    } catch {
      /* 没有这个环境 */
    }
    try {
      fs.readdirSync(path.join(wb, 'versions')).forEach((n) =>
        push(path.join(wb, 'versions', n, 'python.exe')),
      );
    } catch {
      /* 没有这个环境 */
    }
  }

  // 装了 pywin32 的排前面（省掉一串注定失败的 spawn），其余保持原序垫底
  const likely = all.filter(likelyHasWin32Com);
  const rest = all.filter((p) => !likely.includes(p));
  return [...likely, ...rest];
}

/**
 * 找出装了 pywin32 的解释器。
 *
 * **快路径（先走）**：`site-packages\win32com` 目录存在就直接采信，一次进程都不启。
 * 这是 2026-09-15 实测踩出来的：本机 `python.exe` 冷启动要 **20~30 秒**
 * （`user` 0.08 s、`sys` 0.00 s —— 全程在等 I/O，典型的企业 EDR / Defender
 * 实时扫描或磁盘压力），而探测只给 15 秒。结果**所有候选一律超时** → 后端被判为
 * 不可用 → 界面自动取消勾选并禁用语音开关 → 用户看到的现象是「新导入的歌不播报」，
 * 而 pywin32 其实装得好好的。
 *
 * 用目录存在性代替启动实测，检测从分钟级降到毫秒级，也不再受机器负载影响。
 * 代价可控：万一 pywin32 装坏了，也只是在合成那一步报错（有 warnings 兜底），
 * 不会比「静默判定无后端」更糟。
 */
function pythonHasWin32(): string | null {
  const candidates = pythonCandidates();

  const staticHit = candidates.find(likelyHasWin32Com);
  if (staticHit) return staticHit;

  // 慢路径：没有任何静态证据时才逐个实测启动。只在「机器上确实没装 pywin32」
  // 时才会走到这里，结论多半是 null；因此设**总预算**兜底 —— 否则扫描面铺开后
  // （PATH + 各版本 + 各 conda + 工具链 envs），慢机器上启动会卡几分钟。
  const deadline = Date.now() + 30_000;
  for (const exe of candidates) {
    if (Date.now() > deadline) break;
    try {
      execFileSync(exe, ['-c', 'import win32com.client'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15_000,
        env: childEnv(),
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      return exe;
    } catch {
      /* 换下一个候选 */
    }
  }
  return null;
}

/** 探测可用的语音后端（结果缓存，避免每次导入都重复探测） */
export function resolveBackend(force = false): ResolvedBackend | null {
  if (!force && backendCache !== undefined) return backendCache;
  const want = (envCompat('TTS') ?? '').toLowerCase();

  const psExe = powershellPath();
  const tryPowerShell = want !== 'python' && exists(psExe);
  if (tryPowerShell) {
    try {
      listVoicesPowerShell();
      backendCache = { name: 'powershell', exe: psExe };
      return backendCache;
    } catch {
      /* PowerShell 不可用，继续找后备 */
    }
  }
  if (want !== 'powershell') {
    const py = pythonHasWin32();
    if (py) {
      backendCache = { name: 'python', exe: py };
      return backendCache;
    }
  }
  backendCache = null;
  return null;
}

// ---------------------------------------------------------------- Python 后备后端

/** 通过 Python + pywin32 调 SAPI 合成。脚本纯 ASCII，文本走 base64 参数。 */
const PY_SYNTH_SCRIPT = [
  'import sys, base64',
  'import win32com.client as w',
  'text = base64.b64decode(sys.argv[1]).decode("utf-8")',
  'out = sys.argv[2]',
  'rate = int(sys.argv[3])',
  'name = sys.argv[4] if len(sys.argv) > 4 else ""',
  'saft = {8000:6,11025:10,12000:14,16000:18,22050:22,24000:26,32000:30,44100:34,48000:38}',
  'voice = w.Dispatch("SAPI.SpVoice")',
  'stream = w.Dispatch("SAPI.SpFileStream")',
  'stream.Format.Type = saft[rate]',
  'stream.Open(out, 3, False)',
  'try:',
  '    voice.AudioOutputStream = stream',
  '    if name:',
  '        for t in voice.GetVoices():',
  '            if t.GetDescription() == name:',
  '                voice.Voice = t',
  '                break',
  '    voice.Speak(text)',
  'finally:',
  '    stream.Close()',
].join('\n');

function synthViaPython(
  exe: string,
  text: string,
  outPath: string,
  rate: number,
  voice: string | null,
): void {
  const args = ['-c', PY_SYNTH_SCRIPT, Buffer.from(text, 'utf8').toString('base64'), outPath, String(rate)];
  if (voice) args.push(voice);
  try {
    execFileSync(exe, args, {
      encoding: 'utf8',
      windowsHide: true,
      // 留足余量：慢机器上 python.exe 冷启动就要 20~30 秒，合成本身只占几秒。
      // 卡在 60 秒会让「机器忙」和「后端坏了」表现成一回事。
      timeout: 180_000,
      env: childEnv(),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (e) {
    const stderr = String((e as { stderr?: string }).stderr ?? '');
    throw new Error(`Python 语音合成失败：${stderr.trim().slice(0, 300) || (e as Error).message}`);
  }
}

/** 通过 Python 列出 SAPI 语音（后备后端下的语音枚举） */
function listVoicesViaPython(exe: string): VoiceInfo[] {
  const script = [
    'import win32com.client as w',
    'v = w.Dispatch("SAPI.SpVoice")',
    'for t in v.GetVoices():',
    '    print(t.GetDescription())',
  ].join('\n');
  const out = execFileSync(exe, ['-c', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    env: childEnv(),
  });
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((name) => ({ name, culture: '', gender: '' }));
}

// ---------------------------------------------------------------- 设备侧辅助

export function speakableDirs(ipodRoot: string): { tracks: string; playlists: string } {
  const base = toPosix(path.join(ipodRoot, 'iPod_Control', 'Speakable'));
  return { tracks: `${base}/Tracks`, playlists: `${base}/Playlists` };
}

/**
 * 探测设备上 Apple 现有语音文件的格式，作为我们生成的默认值。
 * Apple VoiceOver Kit 生成的文件是最权威的格式依据，比猜测可靠。
 */
export function detectSpeakableFormat(ipodRoot: string): { info: WavInfo; source: string } | null {
  const { tracks } = speakableDirs(ipodRoot);
  let files: string[];
  try {
    files = fs.readdirSync(tracks).filter((f) => f.toLowerCase().endsWith('.wav'));
  } catch {
    return null;
  }
  for (const f of files.sort()) {
    const info = parseWav(path.join(tracks, f));
    if (info?.pcm) return { info, source: f };
  }
  return null;
}

/** 写出一个语音文件（原子替换 + fsync）。返回是否真的写入。 */
export function writeVoiceFile(tracksDir: string, dbid: Buffer, wav: Buffer): string {
  ensureDir(tracksDir);
  const dst = path.join(tracksDir, voiceFilename(dbid));
  const tmp = `${dst}.tmp`;
  fs.writeFileSync(tmp, wav);
  flushFile(tmp);
  fs.renameSync(tmp, dst);
  flushFile(dst);
  return dst;
}
