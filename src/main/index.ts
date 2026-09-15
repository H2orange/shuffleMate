/**
 * Electron 主进程：窗口、IPC 路由。
 *
 * 所有重活（磁盘、PowerShell 语音合成）都在主进程执行；
 * 渲染进程只通过白名单 IPC 与其通信，不直接接触文件系统。
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { execFileSync } from 'child_process';
import * as path from 'path';
import { getDeviceInfo, findIpodRoots, findFirstIpod, loadLibrary } from './core/device';
import { expandInputs, inspectLocalFiles } from './core/library';
import { StableDetector } from './core/hotplug';
import { syncDevice, SyncOptions, SyncProgress, SpaceError } from './core/sync';
import {
  listVoices,
  powershellPath,
  speakableDirs,
  ttsDiagnostics,
} from './core/voiceover';
import { exists } from './core/fsx';

const isDev = process.argv.includes('--dev');
let win: BrowserWindow | null = null;

// 无头/沙箱/精简版虚拟机环境里 Chromium 可能拿不到可用的 GPU 进程，进而打印
// `FATAL: gpu_data_manager_impl_private.cc GPU process isn't usable. Goodbye.`
// 并**直接退出**——这是进程级 FATAL，try/catch 兜不住，应用表现为"双击没反应"。
// 用 `--software-render` 或 `SHUFFLEMATE_SOFTWARE_RENDER=1` 强制软件渲染即可绕过。
// （项目改名前该变量叫 `IPODTOOLS_SOFTWARE_RENDER`，旧名仍然兼容，见 voiceover.ts 的 envCompat。）
// 注意：只调 disableHardwareAcceleration() 不够，Chromium 仍会拉起 GPU 进程，
// 需一并关掉 gpu 与软件光栅化。以下都必须在 `app.whenReady()` 之前执行。
//
// 另有少数执行环境（受限容器、CI）Chromium 沙箱本身就无法初始化，那属于另一回事，
// 由 Electron 原生的 `--no-sandbox` 处理，此处不做自动降级以免削弱正常环境的安全性。
export const softwareRender =
  process.argv.includes('--software-render') ||
  (process.env.SHUFFLEMATE_SOFTWARE_RENDER ?? process.env.IPODTOOLS_SOFTWARE_RENDER) === '1';
if (softwareRender) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-software-rasterizer');
}

// 打包后 Chromium 沙箱在某些环境（受限容器、企业策略、杀毒软件）下
// 创建命名管道会失败，触发 FATAL:platform_channel.cc(89) 直接崩溃。
// 对桌面应用来说进程级沙箱收益有限，打包版本默认关闭以避免崩溃。
const isPackaged = !process.argv.includes('--dev') && !process.defaultApp;
if (isPackaged && !process.argv.includes('--no-sandbox')) {
  app.commandLine.appendSwitch('no-sandbox');
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#f5f6fb',
    title: 'Shuffle 管家',
    icon: path.join(app.getAppPath(), 'assets', 'icon.ico'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => win?.show());
  void win.loadFile(path.join(app.getAppPath(), 'src', 'renderer', 'index.html'));
  if (isDev) {
    win.webContents.openDevTools({ mode: 'detach' });
    // 把渲染进程的日志转发到主进程 stdout，便于命令行排查
    win.webContents.on('console-message', (...args: unknown[]) => {
      const a = args as [unknown, unknown, string?, number?, string?];
      const msg = typeof a[1] === 'number' ? a[2] : (a[1] as { message?: string })?.message;
      const src = typeof a[1] === 'number' ? a[4] : (a[1] as { sourceId?: string })?.sourceId;
      const line = typeof a[1] === 'number' ? a[3] : (a[1] as { lineNumber?: number })?.lineNumber;
      console.log(`[renderer] ${msg ?? ''}  (${src ?? ''}:${line ?? ''})`);
    });
    win.webContents.on('render-process-gone', (_e, d) =>
      console.error('[renderer] 进程异常退出:', d),
    );
  }

  win.on('closed', () => {
    win = null;
  });
}

// ---------------------------------------------------------------- 设备热插拔
//
// 为什么用轮询而不是 Windows 的 WM_DEVICECHANGE 设备事件：
// 事件方式要么写原生 Node 插件、要么常驻一个 WMI 订阅进程，前者需要 node-gyp
// 针对 Electron 的 ABI 重新编译（本机 nvm4w + 企业策略环境下风险高），后者会给
// 打包引入额外可执行文件。而**探测本身极便宜**：findIpodRoots() 只是对 A:–Z:
// 做 26 次 existsSync，不启动任何子进程；真正昂贵的 volumeLabel()（要起
// PowerShell）和 loadLibrary()（要读全部文件）只在状态真的变化时各跑一次。
//
// 去抖（连续 2 次观测才认账）由 core/hotplug.ts 负责 —— 单独成模块是为了能
// 脱离 Electron 直接测，见 test-core 的 T10。
const HOTPLUG_INTERVAL_MS = 1000;

let hotplugTimer: NodeJS.Timeout | null = null;
let hotplugDetector: StableDetector | null = null;

function broadcastDeviceChanged(root: string | null): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('device:changed', { root });
  }
}

function startHotplugWatch(): void {
  if (hotplugTimer) return;
  // 初值取当前实际状态：界面首次渲染由渲染进程自己 refreshDevices() 负责，
  // 这里只管"之后的变化"，避免启动时重复推一次。
  let initial: string | null = null;
  try {
    initial = findFirstIpod();
  } catch {
    initial = null;
  }
  hotplugDetector = new StableDetector(initial, 2);

  hotplugTimer = setInterval(() => {
    let now: string | null;
    try {
      now = findFirstIpod();
    } catch {
      return; // 探测本身抛错就跳过这一轮，绝不把"读不到"当作"已拔出"
    }
    const r = hotplugDetector!.observe(now);
    if (!r.changed) return;
    console.log(`[hotplug] 设备${r.root ? `已接入 ${r.root}` : '已断开'}`);
    broadcastDeviceChanged(r.root);
  }, HOTPLUG_INTERVAL_MS);
}

function stopHotplugWatch(): void {
  if (hotplugTimer) clearInterval(hotplugTimer);
  hotplugTimer = null;
  hotplugDetector = null;
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  startHotplugWatch();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopHotplugWatch();
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------- IPC

function registerIpc(): void {
  ipcMain.handle('device:list', () =>
    findIpodRoots().map((root) => {
      try {
        return getDeviceInfo(root);
      } catch (e) {
        return { root, error: (e as Error).message };
      }
    }),
  );

  ipcMain.handle('device:load', (_e, root: string) => {
    const lib = loadLibrary(root, true);
    return {
      tracks: lib.tracks,
      missingFiles: lib.missingFiles,
      orphanFiles: lib.orphanFiles,
      voiceoverEnabled: !!lib.model.root.voiceover,
      voiceoverSupported: exists(speakableDirs(root).tracks),
    };
  });

  ipcMain.handle('device:eject', async (_e, root: string) => eject(root));

  ipcMain.handle('library:pickFiles', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: '选择要导入的音乐',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '音频文件', extensions: ['mp3', 'm4a', 'mp4', 'aac'] }],
    });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('library:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: '选择音乐文件夹',
      properties: ['openDirectory'],
    });
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  });

  ipcMain.handle('library:expand', (_e, inputs: string[]) => expandInputs(inputs));
  ipcMain.handle('library:inspect', (_e, paths: string[]) => inspectLocalFiles(paths));

  ipcMain.handle('voiceover:voices', () => listVoices());

  ipcMain.handle('voiceover:diagnostics', () => ttsDiagnostics());

  ipcMain.handle('shell:reveal', (_e, p: string) => {
    shell.showItemInFolder(p);
  });

  ipcMain.handle('sync:run', async (_e, root: string, opts: SyncOptions) => {
    const backupsRoot = path.join(app.getPath('userData'), 'backups');
    const sender = _e.sender;
    try {
      return await syncDevice(root, backupsRoot, {
        ...opts,
        onProgress: (p: SyncProgress) => {
          if (!sender.isDestroyed()) sender.send('sync:progress', p);
        },
      });
    } catch (e) {
      if (e instanceof SpaceError) {
        return { ok: false, kind: 'space', message: e.message };
      }
      return { ok: false, kind: 'error', message: (e as Error).message };
    }
  });
}

/**
 * 安全弹出设备。
 *
 * 这不是锦上添花 —— FAT32 有写缓存，不刷盘就拔线，设备读到的会是旧数据库。
 * 与其只提示用户"记得安全弹出"，不如直接把这件事做完。
 */
function eject(root: string): boolean {
  const letter = root.replace(/:.*$/, '');
  if (!/^[A-Za-z]$/.test(letter)) return false;
  const script = [
    "$ErrorActionPreference='Stop'",
    '$sh = New-Object -comObject Shell.Application',
    `$item = $sh.Namespace(17).ParseName(${JSON.stringify(`${letter}:`)})`,
    'if ($item -eq $null) { throw "drive not found" }',
    "$item.InvokeVerb('Eject')",
    "[Console]::Out.WriteLine('OK')",
  ].join('\n');
  try {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    execFileSync(
      powershellPath(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { encoding: 'utf8', windowsHide: true, timeout: 20_000 },
    );
    return true;
  } catch {
    return false;
  }
}
