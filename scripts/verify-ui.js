/**
 * 界面自检：用 Electron 真实渲染 src/renderer/index.html，然后读回
 * `hidden` 元素的 computed display 与外框尺寸。
 *
 * 之所以需要它：`overlay.hidden = true` 只是设了个 HTML 属性，真正决定可见性的是
 * CSS。作者样式表里的 `display` 会盖掉浏览器默认样式表的 `[hidden] {display:none}`，
 * 于是"逻辑上已隐藏"和"视觉上已隐藏"会脱节——这类 bug 读代码看不出来。
 *
 * 用法：node_modules/electron/dist/electron.exe scripts/verify-ui.js --disable-gpu
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const REPORT = path.join(__dirname, '.ui-probe.json');

// 受限容器 / CI 里 Chromium 沙箱可能无法初始化（表现为直接退出、无任何输出）。
// 本脚本只加载本地 src/renderer 的静态资源、不访问网络，关掉沙箱是安全的。
app.commandLine.appendSwitch('no-sandbox');
// 同理，无头环境没有可用 GPU 进程时会 FATAL 硬退出。
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

const PROBE = `(() => {
  const box = (id) => {
    const el = document.getElementById(id);
    if (!el) return { missing: true };
    const r = el.getBoundingClientRect();
    return {
      hiddenAttr: el.hidden,
      display: getComputedStyle(el).display,
      visibility: getComputedStyle(el).visibility,
      boxW: Math.round(r.width),
      boxH: Math.round(r.height),
      visible: r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden',
    };
  };
  return {
    // 本脚本不挂 preload，因此 window.ipod 不存在、app.js 会切到预览数据。
    // 把这件事显式报出来，否则报告里的「设备栏：X317」会被误读成真机。
    mode: window.ipod ? 'real' : 'preview',
    overlay: box('overlay'),
    progress: box('progress'),
    deviceSlot: document.getElementById('deviceSlot')?.textContent?.trim().replace(/\\s+/g, ' '),
    deviceCount: document.getElementById('deviceCount')?.textContent,
    status: document.getElementById('status')?.textContent,
    voBackend: document.getElementById('voBackend')?.textContent,
  };
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200,
    height: 780,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  });

  const errors = [];
  win.webContents.on('console-message', (...a) => {
    const m = typeof a[1] === 'number' ? a[2] : a[1]?.message;
    if (m) errors.push(m);
  });

  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  // 给 app.js 的启动流程留出时间（设备探测 / 语音诊断）
  await new Promise((r) => setTimeout(r, 2500));

  const afterBoot = await win.webContents.executeJavaScript(PROBE);

  // 对弹层做一次"显示 → 隐藏"的 A/B，直接确认 hidden 属性与真实可见性是否一致
  const dialogCycle = await win.webContents.executeJavaScript(`(() => {
    const o = document.getElementById('overlay');
    const snap = (label) => {
      const r = o.getBoundingClientRect();
      return {
        step: label,
        hiddenAttr: o.hidden,
        display: getComputedStyle(o).display,
        visible: r.width > 0 && r.height > 0,
      };
    };
    const out = [snap('初始（应不可见）')];
    o.hidden = false; out.push(snap('显式打开（应可见）'));
    o.hidden = true;  out.push(snap('显式关闭（应不可见）'));
    return out;
  })()`);

  const [, opened, closed] = dialogCycle;

  // 破坏性操作守门：标记曲目后点「移除」，必须弹确认而不是直接开删
  const guard = await win.webContents.executeJavaScript(`(() => {
    document.getElementById('btnSelectAll').click();
    document.getElementById('btnRemove').click();
    const ok = document.getElementById('dialogOk');
    const cancel = document.getElementById('dialogCancel');
    const o = document.getElementById('overlay');
    const snap = {
      overlayVisible: o.getBoundingClientRect().height > 0,
      decided: document.getElementById('deviceCount').textContent,
      title: document.getElementById('dialogTitle').textContent,
      okText: ok.textContent,
      okClass: ok.className,
      cancelShown: cancel.hidden === false,
      cancelText: cancel.textContent,
    };
    cancel.click();   // 取消后应关闭且不写入
    snap.closedAfterCancel = o.getBoundingClientRect().height === 0;
    return snap;
  })()`);

  // 一致性清理的守门：没有待移除的曲目、但存在失效记录/孤儿文件时，
  //「移除」按钮必须是可用的（否则用户永远清不掉），且点击后弹的是「清理」确认框。
  const cleanupGuard = await win.webContents.executeJavaScript(`(() => {
    const ui = window.__ipodUi;
    if (!ui) return { missing: 'no-hook' };
    ui.state.root = 'F:/';
    ui.state.marked = new Set();
    ui.state.pending = [];
    ui.state.device = Object.assign({}, ui.state.device || {}, { __missing: 2, __orphan: 3 });
    ui.renderActionBar();

    const btn = document.getElementById('btnRemove');
    const snap = {
      btnEnabled: !btn.disabled,
      status: document.getElementById('status').textContent,
    };
    btn.click();
    const ok = document.getElementById('dialogOk');
    const cancel = document.getElementById('dialogCancel');
    const o = document.getElementById('overlay');
    snap.visible = o.getBoundingClientRect().height > 0;
    snap.title = document.getElementById('dialogTitle').textContent;
    snap.okText = ok.textContent;
    snap.okClass = ok.className;
    snap.hasCancel = cancel.hidden === false;
    snap.body = document.getElementById('dialogBody').textContent || '';
    cancel.click();
    snap.closedAfterCancel = o.getBoundingClientRect().height === 0;
    return snap;
  })()`);

  // 两个按钮必须互不越界 —— 这是本次改动的核心，也是最容易悄悄退化的地方：
  // 只要有人图省事把两个动作又合回一次调用，下面这些断言就会红。
  // 断言的是**真正发给主进程的参数**，不是按钮上写了什么字。
  const writeIsolation = await win.webContents.executeJavaScript(`(async () => {
    const ui = window.__ipodUi;
    if (!ui) return { missing: 'no-hook' };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const overlayVisible = () => document.getElementById('overlay').getBoundingClientRect().height > 0;
    const dlgTitle = () => document.getElementById('dialogTitle').textContent;

    // 清掉上一段探针留下的清理标记，避免干扰按钮可用性
    ui.state.root = 'F:/';
    ui.state.device = Object.assign({}, ui.state.device || {}, { __missing: 0, __orphan: 0 });

    const mkPending = (title) => ({
      path: 'D:/Music/' + title + '.mp3', fileName: title + '.mp3', fileSize: 4194304,
      title, artist: '测试', album: '', durationMs: 269000, format: 'MP3',
    });

    // 拦截真正发给主进程的调用参数
    const calls = [];
    const realRun = ui.api.runSync;
    ui.api.runSync = async (root, opts) => {
      calls.push({ root, opts });
      return { ok: true, added: opts.addSources.length, removed: opts.removeIds.length,
               voiceoverCreated: 0, voiceoverSkipped: 0, bytesWritten: 1024, backupPath: null,
               ghostPruned: 0, orphanRemoved: 0, orphanVoiceRemoved: 0, orphanKept: 0, warnings: [] };
    };

    // —— 场景：既加了歌、又把设备上的曲目全勾上，两者同时待处理 ——
    ui.state.pending = [mkPending('晴天')];
    ui.state.marked = new Set(ui.state.tracks.map((t) => t.id));
    ui.renderLocal();
    ui.renderDevice();
    ui.renderActionBar();

    const snap = {
      writeLabel: document.getElementById('btnWrite').textContent,
      removeLabel: document.getElementById('btnRemove').textContent,
      markedCount: ui.state.marked.size,
    };

    // ① 点「写入 iPod」：不得出现任何确认框，只能有「写入完成」的结果
    document.getElementById('btnWrite').click();
    await sleep(500);
    snap.writeDialogTitle = overlayVisible() ? dlgTitle() : '';
    if (overlayVisible()) document.getElementById('dialogOk').click();
    const w = calls[0];
    snap.writeCalls = calls.length;
    snap.writeAddSources = w ? w.opts.addSources.length : -1;
    snap.writeRemoveIds = w ? w.opts.removeIds.length : -1;
    snap.writePruneOrphans = w ? w.opts.pruneOrphans : 'n/a';
    // 写入只消化「待导入」这笔待办，勾选的移除必须原样保留
    snap.markedKeptAfterWrite = ui.state.marked.size;
    snap.pendingAfterWrite = ui.state.pending.length;

    // ② 点「移除」：必须弹确认，且参数里只有删除、没有任何新增
    calls.length = 0;
    ui.state.pending = [mkPending('海阔天空')];
    ui.state.marked = new Set([ui.state.tracks[0].id]);
    ui.renderLocal();
    ui.renderDevice();
    ui.renderActionBar();

    document.getElementById('btnRemove').click();
    snap.removeDialogShown = overlayVisible();
    snap.removeDialogTitle = overlayVisible() ? dlgTitle() : '';
    if (overlayVisible()) document.getElementById('dialogOk').click();   // 确认执行
    await sleep(500);
    const r = calls[0];
    snap.removeAddSources = r ? r.opts.addSources.length : -1;
    snap.removeRemoveIds = r ? r.opts.removeIds.length : -1;
    snap.removePruneOrphans = r ? r.opts.pruneOrphans : 'n/a';
    // 移除只消化「勾选」这笔待办，待导入列表必须原样保留
    snap.pendingKeptAfterRemove = ui.state.pending.length;
    snap.markedAfterRemove = ui.state.marked.size;

    // ③ 没有新歌可写、但设备上有曲目缺语音 → 「写入」按钮退化成「补齐语音」且可点。
    //    底层复用同一个 sync 流程，所以这里同时拦住"退化后被悄悄塞进删除指令"
    //    这类退化：参数必须是 addSources=0 / removeIds=0 / pruneOrphans=false。
    calls.length = 0;
    ui.state.pending = [];
    ui.state.marked = new Set();
    ui.state.tracks = ui.state.tracks.map((t, i) =>
      i === ui.state.tracks.length - 1 ? Object.assign({}, t, { exists: true, hasVoiceover: false }) : t,
    );
    ui.renderDevice();
    ui.renderActionBar();
    snap.voiceoverLabel = document.getElementById('btnWrite').textContent;
    snap.voiceoverEnabled = document.getElementById('btnWrite').disabled === false;

    document.getElementById('btnWrite').click();
    await sleep(500);
    if (overlayVisible()) document.getElementById('dialogOk').click();
    const vo = calls[0];
    snap.voiceoverCalls = calls.length;
    snap.voiceoverAddSources = vo ? vo.opts.addSources.length : -1;
    snap.voiceoverRemoveIds = vo ? vo.opts.removeIds.length : -1;
    snap.voiceoverPruneOrphans = vo ? vo.opts.pruneOrphans : 'n/a';
    snap.voiceoverGenerate = vo ? vo.opts.generateVoiceover : 'n/a';

    // 结果弹层的确认按钮回调是 doEject()，点过之后会留下 ejected=true，
    // 影响后面"拔出提示"的分支 —— 用完立刻复位（前面已踩过一次这个坑）。
    ui.state.ejected = false;

    ui.api.runSync = realRun;
    return snap;
  })()`);


  // 待导入行的「移除」：点第 2 行只能删掉第 2 行，不能误伤第 1 行。
  // 列表是按下标重建的，这里同时防住"删错行"和"删完不重绘"两类问题。
  const localRemoveProbe = await win.webContents.executeJavaScript(`(async () => {
    const ui = window.__ipodUi;
    if (!ui) return { missing: 'no-hook' };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    ui.state.root = 'F:/';
    ui.state.marked = new Set();
    ui.state.pending = [
      { path: 'D:/Music/晴天.mp3', fileName: '晴天.mp3', fileSize: 4194304, title: '晴天',
        artist: '周杰伦', album: '叶惠美', durationMs: 269000, format: 'MP3' },
      { path: 'D:/Music/海阔天空.mp3', fileName: '海阔天空.mp3', fileSize: 5242880, title: '海阔天空',
        artist: 'Beyond', album: '乐与怒', durationMs: 326000, format: 'MP3' },
    ];
    ui.renderLocal();
    ui.renderDevice();

    const snap = {
      localRows: document.querySelectorAll('#localList .row').length,
      deviceRows: document.querySelectorAll('#deviceList .row').length,
    };

    const before = ui.state.pending.map((p) => p.title);
    const secondRow = document.querySelectorAll('#localList .row')[1];
    secondRow.querySelector('.icon-btn.remove').click();
    await sleep(60);
    snap.pendingBefore = before.length;
    snap.pendingAfter = ui.state.pending.length;
    snap.removedTitle = before.filter((t) => !ui.state.pending.map((p) => p.title).includes(t))[0];
    snap.intendedTitle = '海阔天空';
    snap.rowsAfter = document.querySelectorAll('#localList .row').length;

    return snap;
  })()`);

  // 设备热插拔：主进程推来 device:changed 后，界面必须立刻收敛。
  // 这里直接调渲染层的 onDeviceChanged（等价于收到 IPC），不需要真机。
  const hotplugProbe = await win.webContents.executeJavaScript(`(async () => {
    const ui = window.__ipodUi;
    if (!ui) return { missing: 'no-hook' };
    const snap = {};
    const txt = (id) => (document.getElementById(id).textContent || '');

    // ---- 先造出"设备已接入、并勾了 2 首要移除"的现场 ----
    // ejected 必须先清掉：前面的用例点过结果弹层的确认按钮，而那个按钮的
    // 回调就是 doEject()，会把 ejected 留成 true，导致断开提示走错分支。
    ui.state.ejected = false;
    ui.state.root = 'F:/';
    ui.state.device = { root: 'F:/', driveLetter: 'F:', volumeLabel: 'X317',
      totalBytes: 2008023040, freeBytes: 1696391168, trackCount: 3, fileCount: 3,
      usedByMusicBytes: 285669440, voiceoverSupported: true, voiceoverEnabled: true,
      version: 0x02010001, __voEnabled: true, __missing: 0, __orphan: 0 };
    ui.state.tracks = [
      { id: 'aaa', title: 'A', artist: '', album: '', filename: 'F00/AAAA.mp3', durationMs: 1000,
        fileSize: 1, format: 'MP3', source: 'itunesdb', exists: true, hasVoiceover: true },
      { id: 'bbb', title: 'B', artist: '', album: '', filename: 'F00/BBBB.mp3', durationMs: 1000,
        fileSize: 1, format: 'MP3', source: 'itunesdb', exists: true, hasVoiceover: true },
    ];
    ui.state.marked = new Set(['aaa', 'bbb']);
    ui.renderDevice();
    ui.renderActionBar();
    snap.markedBefore = ui.state.marked.size;
    snap.ejectEnabledBefore = document.getElementById('btnEject').disabled === false;
    snap.removeEnabledBefore = document.getElementById('btnRemove').disabled === false;

    // ---- 拔出 ----
    await ui.onDeviceChanged(null);
    snap.rootAfterUnplug = ui.state.root;
    snap.deviceAfterUnplug = ui.state.device;
    snap.tracksAfterUnplug = ui.state.tracks.length;
    snap.markedAfterUnplug = ui.state.marked.size;
    snap.slotAfterUnplug = txt('deviceSlot');
    snap.statusAfterUnplug = txt('status');
    snap.rowsAfterUnplug = document.querySelectorAll('#deviceList .row').length;
    snap.ejectDisabledAfterUnplug = document.getElementById('btnEject').disabled;
    snap.removeDisabledAfterUnplug = document.getElementById('btnRemove').disabled;
    snap.writeDisabledAfterUnplug = document.getElementById('btnWrite').disabled;
    snap.localKeptAfterUnplug = ui.state.pending.length;

    // ---- 再插回来：必须自动选中并读回曲库 ----
    await ui.onDeviceChanged('F:/');
    snap.rootAfterReplug = ui.state.root;
    snap.tracksAfterReplug = ui.state.tracks.length;
    snap.ejectEnabledAfterReplug = document.getElementById('btnEject').disabled === false;

    // ---- 「安全弹出」后的断开，提示语应是"可以拔线了"而不是"已断开" ----
    ui.state.ejected = true;
    await ui.onDeviceChanged(null);
    snap.statusAfterEject = txt('status');

    return snap;
  })()`);

  const checks = [
    ['弹层启动时不可见', afterBoot.overlay.hiddenAttr === true && !afterBoot.overlay.visible],
    ['弹层未被 CSS 强制显示', afterBoot.overlay.display === 'none'],
    ['进度条启动时不可见', afterBoot.progress.hiddenAttr === true && !afterBoot.progress.visible],
    ['进度条未被 CSS 强制显示', afterBoot.progress.display === 'none'],
    ['弹层能被打开', opened.display !== 'none' && opened.visible === true],
    ['弹层能被关闭', closed.display === 'none' && closed.visible === false],
    ['移除前弹出确认', guard.overlayVisible === true],
    ['确认框说明将移除几首', /确认从 iPod 移除 \d+ 首/.test(guard.title)],
    ['确认框提供取消按钮', guard.cancelShown === true && /取消/.test(guard.cancelText)],
    ['确认按钮为危险样式', /danger/.test(guard.okClass)],
    ['取消后弹层关闭', guard.closedAfterCancel === true],
    ['有待清理内容时「移除」按钮可用', cleanupGuard.btnEnabled === true],
    ['待清理状态在状态栏可见', /待清理/.test(cleanupGuard.status || '')],
    ['纯清理也先弹确认', cleanupGuard.visible === true && /确认清理/.test(cleanupGuard.title || '')],
    ['清理确认框列出清理内容', /2/.test(cleanupGuard.body || '') && /3/.test(cleanupGuard.body || '')],
    ['清理确认按钮为危险样式', /danger/.test(cleanupGuard.okClass || '')],
    ['清理确认框可取消且不写入', cleanupGuard.hasCancel === true && cleanupGuard.closedAfterCancel === true],

    // ---- 写入 / 移除 两个按钮互不越界（本次改动的核心）----
    ['两个按钮文案各自表明动作',
      /写入/.test(writeIsolation.writeLabel || '') &&
      /移除|清理/.test(writeIsolation.removeLabel || '')],
    ['写入与移除都有待办时，两个按钮同时可用',
      /\d+\s*首/.test(writeIsolation.writeLabel || '') &&
      /\d+\s*首/.test(writeIsolation.removeLabel || '')],
    ['点「写入 iPod」不弹确认框',
      !/确认/.test(writeIsolation.writeDialogTitle || '')],
    ['点「写入 iPod」只提交新增',
      writeIsolation.writeCalls === 1 && writeIsolation.writeAddSources === 1],
    ['点「写入 iPod」不带任何删除指令',
      writeIsolation.writeRemoveIds === 0 && writeIsolation.writePruneOrphans === false],
    ['写入后勾选的待移除曲目原样保留',
      writeIsolation.markedKeptAfterWrite === writeIsolation.markedCount &&
      writeIsolation.markedCount > 0],
    ['写入后待导入列表被清空',
      writeIsolation.pendingAfterWrite === 0],
    ['没有新歌可写但设备缺语音时，按钮退化为「补齐语音」',
      /补齐语音/.test(writeIsolation.voiceoverLabel || '') &&
      writeIsolation.voiceoverEnabled === true],
    ['「补齐语音」走的仍是不删文件的写入流程',
      writeIsolation.voiceoverCalls === 1 &&
      writeIsolation.voiceoverAddSources === 0 &&
      writeIsolation.voiceoverRemoveIds === 0 &&
      writeIsolation.voiceoverPruneOrphans === false &&
      writeIsolation.voiceoverGenerate === true],
    ['点「移除」先弹确认框',
      writeIsolation.removeDialogShown === true &&
      /确认从 iPod 移除/.test(writeIsolation.removeDialogTitle || '')],
    ['点「移除」只提交删除、不带新增',
      writeIsolation.removeAddSources === 0 && writeIsolation.removeRemoveIds === 1],
    ['移除流程才启用一致性清理',
      writeIsolation.removePruneOrphans === true],
    ['移除后待导入列表原样保留',
      writeIsolation.pendingKeptAfterRemove === 1],

    // ---- 待导入列表 ----
    ['待导入行的「移除」只删对应那一行',
      localRemoveProbe.pendingAfter === localRemoveProbe.pendingBefore - 1 &&
      localRemoveProbe.removedTitle === localRemoveProbe.intendedTitle],
    ['移除后列表立即重绘',
      localRemoveProbe.rowsAfter === localRemoveProbe.pendingAfter],

    // ---- 热插拔 ----
    ['断开前设备按钮可用（对照，证明用例本身有效）',
      hotplugProbe.ejectEnabledBefore === true && hotplugProbe.removeEnabledBefore === true],
    ['拔出后清空设备信息（根路径/设备对象/曲目）',
      hotplugProbe.rootAfterUnplug === null &&
      hotplugProbe.deviceAfterUnplug === null &&
      hotplugProbe.tracksAfterUnplug === 0],
    ['拔出后设备曲目列表清空', hotplugProbe.rowsAfterUnplug === 0],
    ['拔出后设备栏显示「未检测到设备」', /未检测到设备/.test(hotplugProbe.slotAfterUnplug || '')],
    ['拔出后状态栏明确提示断开', /断开/.test(hotplugProbe.statusAfterUnplug || '')],
    ['拔出后作废针对该设备的待移除标记',
      hotplugProbe.markedBefore === 2 && hotplugProbe.markedAfterUnplug === 0],
    ['拔出后设备相关按钮全部禁用',
      hotplugProbe.ejectDisabledAfterUnplug === true &&
      hotplugProbe.removeDisabledAfterUnplug === true &&
      hotplugProbe.writeDisabledAfterUnplug === true],
    ['拔出不影响本地待导入列表', hotplugProbe.localKeptAfterUnplug === 1],
    ['重新插入后被自动选中并读回曲库',
      hotplugProbe.rootAfterReplug === 'F:/' && hotplugProbe.tracksAfterReplug > 0],
    ['重新插入后设备按钮恢复可用', hotplugProbe.ejectEnabledAfterReplug === true],
    ['「安全弹出」后的断开提示是「可以拔线了」',
      /可以拔线/.test(hotplugProbe.statusAfterEject || '')],

    ['渲染进程无报错', !errors.some((m) => /error|uncaught/i.test(m))],
  ];

  fs.writeFileSync(
    REPORT,
    JSON.stringify(
      {
        afterBoot,
        dialogCycle,
        deleteGuard: guard,
        cleanupGuard,
        writeIsolation,
        localRemoveProbe,
        hotplugProbe,
        rendererLog: errors,
      },
      null,
      2,
    ),
    'utf8',
  );

  let bad = 0;
  for (const [name, ok] of checks) {
    if (!ok) bad++;
    console.log(`${ok ? ' 通过 ' : ' 失败 '} ${name}`);
  }
  console.log(`\n通过 ${checks.length - bad} · 失败 ${bad}`);
  console.log(`数据源：${afterBoot.mode === 'real' ? '真实设备' : '预览演示数据（未挂 preload）'}`);
  if (afterBoot.mode !== 'real') {
    console.log('        界面与样式表都是真的，但下面这些内容来自演示数据，不代表真机状态：');
  }
  console.log(`设备栏：${afterBoot.deviceSlot || '(空)'}`);
  console.log(`后端  ：${afterBoot.voBackend || '(空)'}`);
  app.exit(bad === 0 ? 0 : 1);
}).catch((e) => {
  fs.writeFileSync(REPORT, JSON.stringify({ fatal: String((e && e.stack) || e) }, null, 2), 'utf8');
  console.error('自检异常：', (e && e.stack) || e);
  app.exit(1);
});
