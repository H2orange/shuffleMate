/* ============================================================
   Shuffle 管家 —— Tauri v2 前端
   ============================================================ */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as shellOpen } from "@tauri-apps/plugin-shell";

// ── 类型 ────────────────────────────────────────────────────

interface DeviceInfo {
  root: string;
  drive_letter: string;
  volume_label: string;
  total_bytes: number;
  free_bytes: number;
  track_count: number;
  file_count: number;
  used_by_music_bytes: number;
  voiceover_supported: boolean;
  voiceover_enabled: boolean;
  version: number;
}

interface TrackView {
  id: string;
  filename: string;
  title: string;
  artist: string;
  album: string;
  duration_ms: number;
  file_size: number;
  format: string;
  source: string;
  exists: boolean;
  has_voiceover: boolean;
}

interface LocalTrack {
  path: string;
  file_name: string;
  file_size: number;
  title: string;
  artist: string;
  album: string;
  duration_ms: number;
  format: string;
  error: string | null;
}

interface LoadedLibrary {
  tracks: TrackView[];
  missing_files: number;
  orphan_files: number;
  voiceover_enabled: boolean;
  voiceover_supported: boolean;
}

interface SyncResult {
  added: number;
  removed: number;
  voiceover_created: number;
  voiceover_skipped: number;
  bytes_written: number;
  backup_path: string | null;
  ghost_pruned: number;
  orphan_removed: number;
  orphan_voice_removed: number;
  orphan_kept: number;
  warnings: string[];
}

interface SyncProgressPayload {
  phase: string;
  message: string;
  current: number;
  total: number;
}

interface SyncOptions {
  add_sources?: string[];
  remove_ids?: string[];
  generate_voiceover?: boolean;
  enable_voiceover?: boolean;
  skip_duplicates?: boolean;
  prune_orphans?: boolean;
}

interface TtsDiagnostics {
  powershell: boolean;
  voices: string[];
  preferred_found: string | null;
}

interface DeviceChangedPayload {
  root: string | null;
}

interface DialogOpts {
  cancelText?: string;
  okClass?: string;
  onClose?: () => void;
}

// ── 状态 ────────────────────────────────────────────────────

const state = {
  root: null as string | null,
  device: null as DeviceInfo | null,
  tracks: [] as TrackView[],
  marked: new Set<string>(),
  pending: [] as LocalTrack[],
  search: "",
  busy: false,
  busyMode: "" as "" | "write" | "remove",
  voiceoverSupported: false,
  tts: null as TtsDiagnostics | null,
  ejected: false,
};

// ── DOM helpers ─────────────────────────────────────────────

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function esc(s: string): string {
  const el = document.createElement("span");
  el.textContent = s;
  return el.innerHTML;
}

// ── 格式化 ──────────────────────────────────────────────────

function fmtBytes(n: number): string {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

function fmtDuration(ms: number): string {
  if (!ms || ms <= 0) return "--:--";
  const t = Math.round(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const p = (x: number) => String(x).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

function fmtCount(n: number): string {
  if (!n) return "0";
  return n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(n);
}

const AUDIO_EXT = new Set([
  ".mp3", ".m4a", ".m4b", ".aac", ".wav", ".flac",
  ".ogg", ".opus", ".wma", ".aiff", ".aif",
]);

// ── 设备卡片 ────────────────────────────────────────────────

function renderDeviceCard(): string {
  const d = state.device;
  if (!d) return "";
  const usedOther = Math.max(0, d.total_bytes - d.free_bytes - d.used_by_music_bytes);
  return `
    <div class="device-card">
      <span class="dot dot-on"></span>
      <div>
        <div class="device-name">${esc(d.volume_label || "iPod Shuffle")}</div>
        <div class="device-sub">${esc(d.drive_letter)} · ${d.voiceover_supported ? "VoiceOver ✓" : "VoiceOver ✗"}</div>
      </div>
      <div class="device-stat">
        <div class="stat"><b>${fmtCount(d.track_count)}</b><span>曲目</span></div>
        <div class="stat"><b>${fmtBytes(d.free_bytes)}</b><span>可用</span></div>
        <div class="stat"><b>${fmtBytes(usedOther)}</b><span>其他</span></div>
      </div>
    </div>
  `;
}

function renderDeviceSlot(): void {
  const slot = $("deviceSlot");
  if (state.device) {
    slot.innerHTML = renderDeviceCard();
  } else {
    slot.innerHTML = `
      <div class="device-empty">
        <span class="dot dot-off"></span>
        <span>未检测到设备</span>
        <button class="btn btn-ghost btn-sm" id="btnRefresh">重新检测</button>
      </div>
    `;
    const btnRefresh = $("btnRefresh");
    if (btnRefresh) btnRefresh.onclick = () => void refreshDevices();
  }
}

// ── 设备曲目列表 ────────────────────────────────────────────

function filteredTracks(): TrackView[] {
  const q = state.search.toLowerCase().trim();
  if (!q) return state.tracks;
  return state.tracks.filter(
    (t) =>
      t.title.toLowerCase().includes(q) ||
      t.artist.toLowerCase().includes(q) ||
      t.album.toLowerCase().includes(q) ||
      t.filename.toLowerCase().includes(q),
  );
}

function renderDevice(): void {
  const list = $("deviceList");
  const countEl = $("deviceCount");
  const rows = filteredTracks();
  const q = state.search.trim();

  countEl.textContent = q ? `${rows.length}/${state.tracks.length}` : String(state.tracks.length);

  if (!state.tracks.length) {
    list.innerHTML = `<li class="empty"><b>设备曲库为空</b>从左侧添加音乐文件到 iPod</li>`;
    renderActionBar();
    return;
  }
  if (!rows.length) {
    list.innerHTML = `<li class="empty"><b>没有匹配的曲目</b>试试其他关键词</li>`;
    renderActionBar();
    return;
  }

  list.innerHTML = rows.map(fmtTrackRow).join("");
  for (const el of list.querySelectorAll<HTMLInputElement>(".ck")) {
    el.onclick = (e) => {
      e.stopPropagation();
      const id = el.dataset.id;
      if (!id) return;
      if (el.checked) state.marked.add(id);
      else state.marked.delete(id);
      renderActionBar();
    };
  }
  for (const el of list.querySelectorAll<HTMLElement>(".act-reveal")) {
    el.onclick = (e) => {
      e.stopPropagation();
      const filename = el.getAttribute("data-filename");
      if (state.root && filename) void shellOpen(state.root + filename);
    };
  }
  renderActionBar();
}

function fmtTrackRow(t: TrackView): string {
  const warn: string[] = [];
  if (!t.exists) warn.push("文件丢失");
  if (t.source === "scan") warn.push("未登记");
  const cls = !t.exists ? "error" : t.source === "scan" ? "warn" : "";
  const subParts = [t.artist, t.album].filter(Boolean);
  const sub = subParts.length ? esc(subParts.join(" · ")) : esc(t.filename);
  const voTag = t.has_voiceover ? `<span class="tag tag-ok">有语音</span>` : `<span class="tag tag-muted">无语音</span>`;
  const warnTag = warn.length ? `<span class="tag tag-warn">${esc(warn.join(" / "))}</span>` : "";
  const metaRight = `
    <span class="meta-right">
      ${voTag}${warnTag}
      <span class="fmt">${esc(t.format)}</span>
      <span class="dur">${fmtDuration(t.duration_ms)}</span>
      <button class="btn btn-ghost btn-xs act-reveal" data-filename="${esc(t.filename)}">打开</button>
    </span>
  `;
  return `
    <li class="track ${cls}">
      <label class="ck"><input type="checkbox" class="ck" data-id="${esc(t.id)}" ${state.marked.has(t.id) ? "checked" : ""} /></label>
      <span class="n" title="${esc(t.title)}">${esc(t.title || "（未命名）")}</span>
      <span class="sub">${sub}</span>
      ${metaRight}
    </li>
  `;
}

// ── 容量条 ──────────────────────────────────────────────────

function renderCapacity(): void {
  const el = $("capacity");
  const d = state.device;
  if (!d) { el.innerHTML = ""; el.hidden = true; return; }
  el.hidden = false;
  const total = d.total_bytes || 1;
  const music = d.used_by_music_bytes;
  const usedOther = Math.max(0, total - d.free_bytes - music);
  const free = d.free_bytes;
  const w = (n: number) => `${((n / total) * 100).toFixed(3)}%`;
  const vo = $("optVoiceover") as HTMLInputElement;
  const missingVo = state.voiceoverSupported ? state.tracks.filter((t) => !t.has_voiceover).length : 0;
  const showVoHint = vo.checked && missingVo > 0;
  const voHint = showVoHint ? `<span class="cap-vo">· 将补齐 ${fmtCount(missingVo)} 首语音</span>` : "";
  el.innerHTML = `
    <div class="cap-row">
      <span class="cap-label">容量</span>
      <span class="cap-legend">
        <span><i class="lg-music"></i>音乐 ${fmtBytes(music)}</span>
        <span><i class="lg-other"></i>其他 ${fmtBytes(usedOther)}</span>
        <span><i class="lg-free"></i>可用 ${fmtBytes(free)}</span>
        ${voHint}
      </span>
    </div>
    <div class="cap-bar">
      <span class="seg seg-music" style="width:${w(music)}"></span>
      <span class="seg seg-other" style="width:${w(usedOther)}"></span>
      <span class="seg seg-free" style="width:${w(free)}"></span>
    </div>
  `;
}

// ── 本地文件列表 ────────────────────────────────────────────

function renderLocal(): void {
  const list = $("localList");
  const countEl = $("localCount");
  const dz = $("dropzone");
  countEl.textContent = String(state.pending.length);
  dz.hidden = state.pending.length > 0;
  if (!state.pending.length) { list.innerHTML = ""; renderActionBar(); return; }
  list.innerHTML = state.pending.map(fmtLocalRow).join("");
  for (const el of list.querySelectorAll<HTMLElement>(".act-remove")) {
    el.onclick = (e) => { e.stopPropagation(); removePending(el.getAttribute("data-path") || ""); };
  }
  for (const el of list.querySelectorAll<HTMLElement>(".act-reopen")) {
    el.onclick = (e) => { e.stopPropagation(); const path = el.getAttribute("data-path"); if (path) void shellOpen(path); };
  }
  renderActionBar();
}

function fmtLocalRow(t: LocalTrack): string {
  const cls = t.error ? "error" : "";
  const main = t.title || t.file_name;
  const meta: string[] = [];
  if (!t.error) {
    if (t.artist) meta.push(esc(t.artist));
    meta.push(fmtDuration(t.duration_ms));
    meta.push(esc(t.format));
    meta.push(fmtBytes(t.file_size));
  }
  const sub = t.error ? `<span class="err">${esc(t.error)}</span>` : meta.join(" · ");
  return `
    <li class="local ${cls}">
      <span class="n" title="${esc(main)}">${esc(main)}</span>
      <span class="sub">${sub}</span>
      <span class="meta-right">
        <button class="btn btn-ghost btn-xs act-reopen" data-path="${esc(t.path)}">打开</button>
        <button class="btn btn-ghost btn-xs act-remove" data-path="${esc(t.path)}">移除</button>
      </span>
    </li>
  `;
}

function removePending(path: string): void {
  state.pending = state.pending.filter((t) => t.path !== path);
  renderLocal();
}

function clearPending(): void { state.pending = []; renderLocal(); }

// ── 状态栏与忙碌 ────────────────────────────────────────────

function setStatus(msg: string, kind: "ok" | "err" | ""): void {
  const el = $("status");
  el.textContent = msg;
  el.className = "status" + (kind ? ` ${kind}` : "");
}

function setBusy(busy: boolean, mode: "" | "write" | "remove" = ""): void {
  state.busy = busy;
  state.busyMode = mode;
  const progress = $("progress");
  const bar = $("progressFill");
  const text = $("progressText");
  if (busy) {
    progress.hidden = false;
    bar.style.width = "0";
    const label = mode === "write" ? "写入中…" : mode === "remove" ? "移除中…" : "处理中…";
    text.textContent = label;
    setStatus(label, "");
  } else {
    progress.hidden = true;
    bar.style.width = "0";
    text.textContent = "";
  }
  renderActionBar();
}

function updateProgress(p: SyncProgressPayload): void {
  const bar = $("progressFill");
  const text = $("progressText");
  const total = Math.max(1, p.total);
  const pct = Math.min(100, Math.round((p.current / total) * 100));
  bar.style.width = `${pct}%`;
  const phase = p.phase === "copy" ? "写入" : p.phase === "remove" ? "移除" : p.phase === "voiceover" ? "语音" : p.phase === "database" ? "数据库" : p.phase === "cleanup" ? "清理" : p.phase;
  const parts = [phase];
  if (p.total > 0) parts.push(`${p.current}/${p.total}`);
  if (p.message) parts.push(p.message);
  text.textContent = parts.join(" · ");
}

// ── 底栏按钮 ────────────────────────────────────────────────

function renderActionBar(): void {
  const btnWrite = $("btnWrite") as HTMLButtonElement;
  const btnRemove = $("btnRemove") as HTMLButtonElement;
  const btnEject = $("btnEject") as HTMLButtonElement;
  const btnSelectAll = $("btnSelectAll") as HTMLButtonElement;
  const btnSelectNone = $("btnSelectNone") as HTMLButtonElement;
  const voInput = $("optVoiceover") as HTMLInputElement;
  const hasDevice = !!state.device;
  const hasPending = state.pending.length > 0;
  const hasMarked = state.marked.size > 0;
  const disabled = state.busy;
  btnWrite.disabled = disabled || !hasDevice || !hasPending;
  btnWrite.textContent = state.busy && state.busyMode === "write" ? "写入中…" : "写入 iPod";
  btnRemove.disabled = disabled || !hasDevice || !hasMarked;
  btnRemove.textContent = state.busy && state.busyMode === "remove" ? "移除中…" : `移除所选 (${state.marked.size})`;
  btnRemove.hidden = !hasMarked && !state.busy;
  btnEject.disabled = disabled || !hasDevice;
  btnEject.textContent = state.busy ? "请稍候…" : "安全弹出";
  btnSelectAll.disabled = disabled || !hasDevice || !state.tracks.length;
  btnSelectNone.disabled = disabled || !state.marked.size;
  voInput.disabled = state.busy || !state.voiceoverSupported;
}

// ── 弹层 / 对话框 ───────────────────────────────────────────

function openDialog(title: string, bodyHtml: string, okText: string, onOk: (() => void) | null, opts?: DialogOpts): void {
  const overlay = $("overlay");
  const dialogTitle = $("dialogTitle");
  const dialogBody = $("dialogBody");
  const dialogOk = $("dialogOk") as HTMLButtonElement;
  const dialogCancel = $("dialogCancel") as HTMLButtonElement;
  dialogTitle.textContent = title;
  dialogBody.innerHTML = bodyHtml;
  dialogOk.textContent = okText;
  dialogOk.className = opts?.okClass || "btn btn-primary";
  dialogOk.onclick = () => { closeDialog(); if (onOk) onOk(); };
  if (opts?.cancelText) {
    dialogCancel.textContent = opts.cancelText;
    dialogCancel.hidden = false;
    dialogCancel.onclick = () => closeDialog();
  } else {
    dialogCancel.hidden = true;
  }
  overlay.hidden = false;
  const closeHandler = () => { closeDialog(); if (opts?.onClose) opts.onClose(); };
  overlay.onclick = (e) => { if (e.target === overlay) closeHandler(); };
}

function closeDialog(): void {
  $("overlay").hidden = true;
  ($("dialogCancel") as HTMLButtonElement).hidden = true;
}

function askConfirm(title: string, bodyHtml: string, okText: string, onOk: () => void, opts?: { okClass?: string; cancelText?: string }): void {
  openDialog(title, bodyHtml, okText, onOk, { cancelText: opts?.cancelText || "取消", okClass: opts?.okClass });
}

// ── 设备操作 ────────────────────────────────────────────────

async function refreshDevices(): Promise<void> {
  if (state.busy) return;
  setStatus("正在检测设备…", "");
  try {
    const devices = await invoke<DeviceInfo[]>("list_devices");
    const dev = devices.length ? devices[0] : null;
    if (dev && dev.root !== state.root) {
      await loadLibraryFor(dev);
    } else if (!dev && state.root) {
      state.root = null; state.device = null; state.tracks = []; state.marked.clear(); state.voiceoverSupported = false;
      renderDeviceSlot(); renderDevice(); renderCapacity(); renderActionBar();
      setStatus("设备已断开", "");
    } else {
      renderDeviceSlot(); renderActionBar();
      setStatus(dev ? "设备已就绪" : "未检测到 iPod Shuffle", "");
    }
  } catch (err) {
    setStatus(`检测失败：${String(err)}`, "err");
  }
}

async function loadLibraryFor(dev: DeviceInfo): Promise<void> {
  state.root = dev.root; state.device = dev; state.voiceoverSupported = dev.voiceover_supported;
  renderDeviceSlot(); renderCapacity(); renderActionBar();
  setStatus("正在读取曲库…", "");
  try {
    const lib = await invoke<LoadedLibrary>("load_device", { root: dev.root });
    state.tracks = lib.tracks; state.marked.clear(); state.voiceoverSupported = lib.voiceover_supported;
    renderDevice(); renderCapacity(); renderActionBar();
    const notes: string[] = [];
    if (lib.missing_files) notes.push(`${lib.missing_files} 个文件丢失`);
    if (lib.orphan_files) notes.push(`${lib.orphan_files} 个孤儿文件`);
    setStatus(`已加载 ${state.tracks.length} 首曲目` + (notes.length ? `（${notes.join("，")}）` : ""), notes.length ? "err" : "ok");
  } catch (err) {
    state.tracks = []; renderDevice();
    setStatus(`读取曲库失败：${String(err)}`, "err");
  }
}

async function onDeviceChanged(root: string | null): Promise<void> {
  if (state.busy) return;
  if (!root) {
    if (!state.root) return;
    const wasEjected = state.ejected;
    state.ejected = false; state.root = null; state.device = null; state.tracks = []; state.marked.clear(); state.voiceoverSupported = false;
    renderDeviceSlot(); renderDevice(); renderCapacity(); renderActionBar();
    setStatus(wasEjected ? "设备已安全弹出" : "设备已断开", "ok");
    return;
  }
  if (root === state.root) return;
  setStatus("检测到设备变化，正在重新加载…", "");
  try {
    const devices = await invoke<DeviceInfo[]>("list_devices");
    const dev = devices.find((d) => d.root === root);
    if (dev) await loadLibraryFor(dev); else await refreshDevices();
  } catch (err) {
    setStatus(`重新加载失败：${String(err)}`, "err");
  }
}

async function doEject(): Promise<void> {
  if (!state.root || state.busy) return;
  setBusy(true); setStatus("正在弹出设备…", "");
  try {
    await invoke("eject", { root: state.root });
    state.ejected = true;
    setStatus("设备已安全弹出，可以拔掉设备。", "ok");
    state.root = null; state.device = null; state.tracks = []; state.marked.clear();
    renderDeviceSlot(); renderDevice(); renderCapacity(); renderActionBar();
  } catch (err) {
    setStatus(`弹出失败：${String(err)}`, "err");
  } finally { setBusy(false); }
}

// ── 文件操作 ────────────────────────────────────────────────

async function addPaths(paths: string[]): Promise<void> {
  if (!paths.length) return;
  setStatus(`正在扫描 ${paths.length} 个项目…`, "");
  try {
    const expanded = await invoke<string[]>("expand_inputs", { inputs: paths });
    const seen = new Set(state.pending.map((t) => t.path.toLowerCase()));
    const fresh = expanded.filter((p) => !seen.has(p.toLowerCase()));
    if (!fresh.length) { setStatus("没有新的可添加音频文件", ""); return; }
    setStatus(`正在读取 ${fresh.length} 个文件信息…`, "");
    const inspected = await invoke<LocalTrack[]>("inspect_files", { paths: fresh });
    state.pending = state.pending.concat(inspected);
    renderLocal();
    const ok = inspected.filter((t) => !t.error).length;
    const bad = inspected.filter((t) => t.error).length;
    setStatus(`已添加 ${ok} 个文件` + (bad ? `，${bad} 个无法读取` : ""), bad ? "err" : "ok");
  } catch (err) {
    setStatus(`添加失败：${String(err)}`, "err");
  }
}

async function pickFiles(): Promise<void> {
  try { const paths = await invoke<string[]>("pick_files"); await addPaths(paths); }
  catch (err) { setStatus(`选择文件失败：${String(err)}`, "err"); }
}

async function pickFolder(): Promise<void> {
  try { const folder = await invoke<string | null>("pick_folder"); if (folder) await addPaths([folder]); }
  catch (err) { setStatus(`选择文件夹失败：${String(err)}`, "err"); }
}

// ── 同步操作 ────────────────────────────────────────────────

async function runSync(mode: "write" | "remove"): Promise<void> {
  if (!state.root || state.busy) return;
  const addSources = mode === "write" ? state.pending.map((t) => t.path) : [];
  const removeIds = mode === "remove" ? Array.from(state.marked) : [];
  const voInput = $("optVoiceover") as HTMLInputElement;
  const dupInput = $("optSkipDup") as HTMLInputElement;
  const opts: SyncOptions = {
    add_sources: addSources.length ? addSources : undefined,
    remove_ids: removeIds.length ? removeIds : undefined,
    generate_voiceover: voInput.checked || undefined,
    enable_voiceover: voInput.checked || undefined,
    skip_duplicates: dupInput.checked || undefined,
    prune_orphans: mode === "remove" ? true : undefined,
  };
  setBusy(true, mode);
  const unlistenProgress = await listen<SyncProgressPayload>("sync:progress", (event) => updateProgress(event.payload));
  try {
    const result = await invoke<SyncResult>("run_sync", { root: state.root, opts });
    unlistenProgress(); setBusy(false);
    showSyncResult(mode, result);
    state.pending = []; state.marked.clear();
    await refreshDevices(); renderLocal();
  } catch (err) {
    unlistenProgress(); setBusy(false);
    setStatus(`${mode === "write" ? "写入" : "移除"}失败：${String(err)}`, "err");
  }
}

function showSyncResult(mode: "write" | "remove", res: SyncResult): void {
  const title = mode === "write" ? "写入完成" : "移除完成";
  const parts: string[] = [];
  if (mode === "write") {
    if (res.added) parts.push(`新增 <b>${res.added}</b> 首`);
    if (res.bytes_written) parts.push(`写入 <b>${fmtBytes(res.bytes_written)}</b>`);
  }
  if (mode === "remove" && res.removed) parts.push(`移除 <b>${res.removed}</b> 首`);
  const voCreated = res.voiceover_created ?? 0;
  const voSkipped = res.voiceover_skipped ?? 0;
  if (voCreated) parts.push(`生成语音 <b>${voCreated}</b> 条`);
  if (voSkipped && mode === "write") parts.push(`已有语音 <b>${voSkipped}</b>`);
  const ghostPruned = res.ghost_pruned ?? 0;
  const orphanRemoved = res.orphan_removed ?? 0;
  const orphanVoiceRemoved = res.orphan_voice_removed ?? 0;
  const orphanKept = res.orphan_kept ?? 0;
  if (ghostPruned) parts.push(`清理无效记录 <b>${ghostPruned}</b>`);
  if (orphanRemoved) parts.push(`删除孤儿文件 <b>${orphanRemoved}</b>`);
  if (orphanVoiceRemoved) parts.push(`删除孤儿语音 <b>${orphanVoiceRemoved}</b>`);
  if (orphanKept) parts.push(`保留孤儿文件 <b>${orphanKept}</b>（需手动确认）`);
  const backupLine = res.backup_path ? `<p style="color:var(--muted);font-size:11px">数据库备份：${esc(res.backup_path)}</p>` : "";
  let warnBlock = "";
  if (res.warnings && res.warnings.length) {
    const items = res.warnings.map((w) => `<li>${esc(w)}</li>`).join("");
    warnBlock = `<div class="warn-list"><b>⚠ 以下操作未完全成功：</b><ul>${items}</ul></div>`;
  }
  const body = `<p>${parts.length ? parts.join("，") + "。" : "操作已完成。"}</p>${warnBlock}${backupLine}`;
  openDialog(title, body, "好", null);
  setStatus(title + "：" + (parts.join("，") || "操作已完成"), "ok");
}

// ── 移除确认 ────────────────────────────────────────────────

function confirmRemove(): void {
  const ids = Array.from(state.marked);
  if (!ids.length) return;
  const removing = state.tracks.filter((t) => ids.includes(t.id));
  const preview = removing.slice(0, 10);
  const more = removing.length - preview.length;
  const listHtml = preview.map((t) => `<div>${esc(t.title || t.filename)}</div>`).join("");
  const moreHtml = more > 0 ? `<div class="pick-more">…另外 ${more} 首</div>` : "";
  askConfirm(
    `确认移除 ${removing.length} 首`,
    `<p>将从设备删除以下曲目（不可恢复）：</p><div class="pick-list">${listHtml}${moreHtml}</div><p style="margin-top:12px">数据库改动前会自动备份，但<b>音频与语音文件不做备份</b>，删掉无法找回。</p>`,
    `确认移除 ${removing.length} 首`,
    () => void runSync("remove"),
    { okClass: "btn btn-danger", cancelText: "取消" },
  );
}

// ── TTS 诊断 ────────────────────────────────────────────────

async function loadTtsDiagnostics(): Promise<void> {
  const tag = $("voBackend");
  const input = $("optVoiceover") as HTMLInputElement;
  const wrap = input.closest(".switch") as HTMLElement;
  let d: TtsDiagnostics | null = null;
  try { d = await invoke<TtsDiagnostics>("tts_diagnostics"); } catch { d = null; }
  state.tts = d;
  if (!d || !d.powershell) {
    tag.textContent = "语音后端不可用"; tag.className = "tag warn";
    input.checked = false; input.disabled = true;
    wrap.title = "未检测到可用的语音合成后端";
    state.voiceoverSupported = false;
    return;
  }
  const voiceName = d.preferred_found || (d.voices.length ? d.voices[0] : "PowerShell TTS");
  const shortName = voiceName.replace(/^Microsoft\s+/, "").split(" - ")[0];
  tag.textContent = `语音：${shortName}`; tag.className = "tag";
  input.disabled = !state.voiceoverSupported;
  wrap.title = `后端：PowerShell${d.preferred_found ? "" : "（未找到中文语音）"}`;
}

// ── 事件绑定 ────────────────────────────────────────────────

function bindEvents(): void {
  ($("btnWrite") as HTMLButtonElement).onclick = () => void runSync("write");
  ($("btnRemove") as HTMLButtonElement).onclick = confirmRemove;
  ($("btnEject") as HTMLButtonElement).onclick = () => void doEject();
  ($("optVoiceover") as HTMLInputElement).onchange = () => { renderCapacity(); renderActionBar(); };
  ($("search") as HTMLInputElement).oninput = (e) => { state.search = (e.target as HTMLInputElement).value; renderDevice(); };
  ($("btnSelectAll") as HTMLButtonElement).onclick = () => { const rows = filteredTracks(); for (const t of rows) state.marked.add(t.id); renderDevice(); };
  ($("btnSelectNone") as HTMLButtonElement).onclick = () => { state.marked.clear(); renderDevice(); };
  ($("btnAddFiles") as HTMLButtonElement).onclick = () => void pickFiles();
  ($("btnAddFolder") as HTMLButtonElement).onclick = () => void pickFolder();
  ($("btnClearLocal") as HTMLButtonElement).onclick = clearPending;
  const dz = $("dropzone");
  void getCurrentWebview().onDragDropEvent((event) => {
    const payload = event.payload;
    if (payload.type === "enter") { dz.classList.add("hot"); }
    else if (payload.type === "leave") { dz.classList.remove("hot"); }
    else if (payload.type === "drop") {
      dz.classList.remove("hot");
      const paths = payload.paths.filter((p: string) => {
        const dot = p.lastIndexOf("."); if (dot < 0) return false;
        return AUDIO_EXT.has(p.substring(dot).toLowerCase());
      });
      if (paths.length) void addPaths(paths);
    }
  });
  $("overlay").addEventListener("click", (e) => { if (e.target === $("overlay")) closeDialog(); });
}

// ── 启动 ────────────────────────────────────────────────────

async function init(): Promise<void> {
  bindEvents(); renderLocal(); renderCapacity(); renderActionBar();
  await loadTtsDiagnostics();
  void listen<DeviceChangedPayload>("device:changed", (event) => { void onDeviceChanged(event.payload.root); });
  await refreshDevices();
  console.info(
    `[Shuffle 管家] 界面就绪 — 设备 ${state.root ?? "未连接"}，曲目 ${state.tracks.length}，待导入 ${state.pending.length}，语音后端 ${state.tts?.powershell ? "PowerShell" : "不可用"}`
  );
}

window.addEventListener("DOMContentLoaded", () => void init());
