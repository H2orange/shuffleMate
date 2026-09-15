/* eslint-disable no-console */
/**
 * 设备热插拔的端到端验证 —— 跑的是**真实应用**（真实 IPC + preload + 渲染进程）。
 *
 * 为什么需要它：`verify-ui.js` 不挂 preload，只能直接调渲染层的 `onDeviceChanged`，
 * 覆盖不到 `webContents.send → ipcRenderer.on → 回调` 这一段中继。而这段中继一旦写错
 * （事件名拼错、payload 取错字段），界面就是"点了没反应"，和没写一样。
 *
 * 做法：本脚本自己就运行在主进程里，于是可以**扮演事件源**，直接
 * `win.webContents.send('device:changed', ...)`，走完整条真实链路。
 * 好处是**不需要拔插真机**，也不会碰设备上的任何数据。
 *
 * 注意：这里刻意只推事件，不去改主进程探测器（StableDetector）的内部状态 ——
 * 探测器的判定逻辑由 test:core 的 T10 用观测序列测，两者不重叠。
 *
 * 用法：electron scripts/verify-hotplug.js
 */
'use strict';

const path = require('path');

const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('no-sandbox');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

const ROOT = path.join(__dirname, '..');
app.setAppPath(ROOT);
require(path.join(ROOT, 'dist', 'main', 'index.js'));

const REPORT = path.join(__dirname, '.hotplug-probe.json');
const fs = require('fs');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  console.log(`  ${ok ? '通过' : '失败'}  ${name}${detail ? `  [${detail}]` : ''}`);
}

/** 从渲染进程读回当前设备相关状态 */
const READ_STATE = `(() => {
  const ui = window.__ipodUi;
  if (!ui) return { missing: 'no-ui-hook' };
  const slot = document.getElementById('deviceSlot');
  return {
    root: ui.state.root,
    hasDevice: !!ui.state.device,
    tracks: ui.state.tracks.length,
    marked: ui.state.marked.size,
    slotText: (slot ? (slot.textContent || '') : ''),
    statusText: (document.getElementById('status') || {}).textContent || '',
    ejectDisabled: document.getElementById('btnEject').disabled,
    removeDisabled: document.getElementById('btnRemove').disabled,
    writeDisabled: document.getElementById('btnWrite').disabled,
    rows: document.querySelectorAll('#deviceList .row').length,
  };
})()`;

/** 预加载里是否真的挂上了订阅接口（验证 preload 是新的） */
const READ_API = `(() => {
  const api = window.ipod;
  return {
    hasApi: !!api,
    hasOnDeviceChange: !!(api && typeof api.onDeviceChange === 'function'),
  };
})()`;

(async () => {
  let win = null;
  for (let i = 0; i < 100 && !win; i++) {
    win = BrowserWindow.getAllWindows()[0] || null;
    if (!win) await wait(100);
  }
  if (!win) {
    console.error('拿不到窗口，无法验证');
    app.exit(1);
    return;
  }
  if (win.webContents.isLoading()) {
    await new Promise((r) => win.webContents.once('did-finish-load', r));
  }
  await wait(3000); // 等渲染层的启动流程（含首轮设备检测）跑完

  console.log('\n设备热插拔端到端验证（真实应用 + 真实 IPC）');
  console.log('─'.repeat(64));

  // ---- 0) 前提：界面真的加载了、preload 真的暴露了订阅接口 ----
  const api = await win.webContents.executeJavaScript(READ_API);
  check('界面加载了真实页面且 preload 生效', api.hasApi === true);
  check('preload 暴露了 onDeviceChange', api.hasOnDeviceChange === true);
  if (!api.hasOnDeviceChange) {
    console.error('\npreload 没暴露 onDeviceChange —— 后面全部无意义，直接退出');
    app.exit(1);
    return;
  }

  // ---- 1) 初始状态：真机此刻是插着的（否则本验证没有真实设备可回读）----
  const initial = await win.webContents.executeJavaScript(READ_STATE);
  console.log(`  初始：root=${initial.root} 曲目=${initial.tracks}`);
  const realRoot = initial.root;
  check('启动时检测到真机（后续要靠它验证"插回来自动读曲库"）', !!realRoot, String(realRoot));
  if (!realRoot) {
    console.error('\n未接入 iPod，跳过（本验证需要真机在场）');
    app.exit(2);
    return;
  }

  // ---- 2) 推一次"已拔出" ----
  win.webContents.send('device:changed', { root: null });
  await wait(700);
  const gone = await win.webContents.executeJavaScript(READ_STATE);

  check('★ 渲染进程收到了 device:changed（拔出）', gone.root === null, `root=${gone.root}`);
  check('设备对象被清空', gone.hasDevice === false);
  check('曲目列表被清空', gone.tracks === 0 && gone.rows === 0, `${gone.tracks} 首 / ${gone.rows} 行`);
  check('设备栏显示「未检测到设备」', /未检测到设备/.test(gone.slotText), gone.slotText.slice(0, 40));
  check('状态栏提示已断开', /断开/.test(gone.statusText), gone.statusText);
  check(
    '设备相关按钮全部禁用',
    gone.ejectDisabled === true && gone.removeDisabled === true && gone.writeDisabled === true,
    `弹出=${gone.ejectDisabled} 移除=${gone.removeDisabled} 写入=${gone.writeDisabled}`,
  );

  // ---- 3) 推一次"已插入"，必须自动选中并真的读回曲库 ----
  win.webContents.send('device:changed', { root: realRoot });
  await wait(2500); // 真实读曲库要扫目录、读 ID3
  const back = await win.webContents.executeJavaScript(READ_STATE);

  check('★ 渲染进程收到了 device:changed（插入）', back.root === realRoot, `root=${back.root}`);
  check('自动重新读到了曲库', back.tracks > 0, `${back.tracks} 首`);
  check('设备栏恢复显示设备卡片', !/未检测到设备/.test(back.slotText), back.slotText.slice(0, 40));
  check('「安全弹出」按钮恢复可用', back.ejectDisabled === false);
  check(
    '读回的曲目数与初始一致',
    back.tracks === initial.tracks,
    `初始 ${initial.tracks} → 现在 ${back.tracks}`,
  );

  fs.writeFileSync(
    REPORT,
    JSON.stringify({ initial, gone, back, results }, null, 2),
    'utf8',
  );

  const bad = results.filter((r) => !r.ok).length;
  console.log('─'.repeat(64));
  console.log(`通过 ${results.length - bad} · 失败 ${bad}`);
  console.log(`报告：${REPORT}`);
  app.exit(bad === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\n验证异常：', (e && e.stack) || e);
  app.exit(1);
});
