/**
 * 预加载脚本：向渲染进程暴露一个白名单 API。
 *
 * 渲染进程拿不到 Node/文件系统能力，只能调用这里列出的方法。
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';

export interface IpodApi {
  listDevices(): Promise<unknown[]>;
  loadLibrary(root: string): Promise<unknown>;
  eject(root: string): Promise<boolean>;
  pickFiles(): Promise<string[]>;
  pickFolder(): Promise<string | null>;
  expandInputs(inputs: string[]): Promise<string[]>;
  inspectFiles(paths: string[]): Promise<unknown[]>;
  listVoices(): Promise<{ name: string; culture: string; gender: string }[]>;
  ttsDiagnostics(): Promise<{
    backend: 'powershell' | 'python' | null;
    powershell: string;
    powershellFound: boolean;
    python: string | null;
    voices: { name: string; culture: string; gender: string }[];
    error: string | null;
  }>;
  reveal(p: string): Promise<void>;
  runSync(root: string, opts: Record<string, unknown>): Promise<unknown>;
  onProgress(cb: (p: unknown) => void): () => void;
  /**
   * 订阅设备插入/拔出。主进程每秒探测一次，只有状态**真的变化**才推。
   * 回调参数是当前设备根路径（`F:/`），拔掉时为 `null`。
   */
  onDeviceChange(cb: (root: string | null) => void): () => void;
  /** Electron 32+ 移除了 File.path，必须经由 webUtils 取拖入文件的真实路径 */
  pathForFile(file: File): string;
}

const api: IpodApi = {
  listDevices: () => ipcRenderer.invoke('device:list'),
  loadLibrary: (root) => ipcRenderer.invoke('device:load', root),
  eject: (root) => ipcRenderer.invoke('device:eject', root),
  pickFiles: () => ipcRenderer.invoke('library:pickFiles'),
  pickFolder: () => ipcRenderer.invoke('library:pickFolder'),
  expandInputs: (inputs) => ipcRenderer.invoke('library:expand', inputs),
  inspectFiles: (paths) => ipcRenderer.invoke('library:inspect', paths),
  listVoices: () => ipcRenderer.invoke('voiceover:voices'),
  ttsDiagnostics: () => ipcRenderer.invoke('voiceover:diagnostics'),
  reveal: (p) => ipcRenderer.invoke('shell:reveal', p),
  runSync: (root, opts) => ipcRenderer.invoke('sync:run', root, opts),
  onProgress: (cb) => {
    const handler = (_e: unknown, p: unknown) => cb(p);
    ipcRenderer.on('sync:progress', handler);
    return () => {
      ipcRenderer.off('sync:progress', handler);
    };
  },
  onDeviceChange: (cb) => {
    const handler = (_e: unknown, payload: unknown) => {
      const root = (payload as { root?: string | null } | null)?.root ?? null;
      cb(root || null);
    };
    ipcRenderer.on('device:changed', handler);
    return () => {
      ipcRenderer.off('device:changed', handler);
    };
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld('ipod', api);
