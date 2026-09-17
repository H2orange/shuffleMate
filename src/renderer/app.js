/* ============================================================
   Shuffle 管家 —— 渲染进程
   与主进程只通过 window.ipod 暴露的白名单 API 通信。
   ============================================================ */

(function () {
  'use strict';

  const api = window.ipod || createPreviewApi();

  /**
   * 在没有 Electron 宿主时（例如直接用浏览器打开本页做界面预览）
   * 提供一份演示数据，让界面仍然可浏览。真实运行时不会走到这里。
   */
  function createPreviewApi() {
    const tracks = [
      { id: '5cda284d1d1a1083', filename: 'iPod_Control/Music/F00/SBJT.mp3', title: '六级模拟试题 1', artist: '', album: '', durationMs: 1496816, fileSize: 23949061, format: 'MP3', source: 'itunesdb', exists: true, hasVoiceover: true },
      { id: 'b2861d8e90e29c20', filename: 'iPod_Control/Music/F02/DQMD.mp3', title: '2009年12月六级听力真题', artist: '', album: '', durationMs: 1926347, fileSize: 15415006, format: 'MP3', source: 'itunesdb', exists: true, hasVoiceover: true },
      { id: 'a9ab53b7a92376c4', filename: 'iPod_Control/Music/F00/YTKZ.mp3', title: '2010年12月六级听力真题', artist: '', album: '', durationMs: 2069968, fileSize: 10354069, format: 'MP3', source: 'itunesdb', exists: true, hasVoiceover: false },
    ];
    const device = {
      root: 'F:/', driveLetter: 'F:', volumeLabel: 'X317',
      totalBytes: 2008023040, freeBytes: 1696391168,
      trackCount: 13, fileCount: 13, usedByMusicBytes: 285669440,
      voiceoverSupported: true, voiceoverEnabled: true, version: 0x02010001,
      __voEnabled: true, __missing: 0, __orphan: 0,
    };
    const pending = [
      { path: 'D:/Music/晴天.mp3', fileName: '晴天.mp3', fileSize: 4194304, title: '晴天', artist: '周杰伦', album: '叶惠美', durationMs: 269000, format: 'MP3' },
      { path: 'D:/Music/海阔天空.mp3', fileName: '海阔天空.mp3', fileSize: 5242880, title: '海阔天空', artist: 'Beyond', album: '乐与怒', durationMs: 326000, format: 'MP3' },
    ];
    const wait = (v) => () => new Promise((r) => setTimeout(() => r(v), 80));
    // 预览模式没有主进程，热插拔事件由自检脚本手动触发（见 __fireDeviceChange）
    let deviceCb = null;
    return {
      listDevices: wait([device]),
      loadLibrary: wait({ tracks, missingFiles: 0, orphanFiles: 0, voiceoverEnabled: true, voiceoverSupported: true }),
      eject: wait(true),
      pickFiles: wait([]),
      pickFolder: wait(null),
      expandInputs: wait([]),
      inspectFiles: wait([]),
      listVoices: wait([]),
      ttsDiagnostics: wait({ backend: 'powershell', powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', powershellFound: true, python: null, voices: [{ name: 'Microsoft Huihui Desktop', culture: 'zh-CN', gender: 'Female' }], error: null }),
      reveal: async () => {},
      runSync: wait({ ok: true, added: 2, removed: 1, voiceoverCreated: 14, voiceoverSkipped: 2, bytesWritten: 9437184, backupPath: 'backups/20260915-121500-prechange/iTunesSD', ghostPruned: 0, orphanRemoved: 1, orphanVoiceRemoved: 1, orphanKept: 0, warnings: ['已删除未登记音频（数据库未引用，设备本来也播不到） 1 个：iPod_Control/Music/F02/MQXP.mp3'] }),
      onProgress: () => () => {},
      onDeviceChange: (cb) => {
        deviceCb = cb;
        return () => {
          deviceCb = null;
        };
      },
      /** 自检专用：手动投递一次设备插拔事件 */
      __fireDeviceChange: (root) => {
        if (deviceCb) deviceCb(root);
      },
      pathForFile: () => '',
      __preview: true,
      __pending: pending,
    };
  }

  const state = {
    root: null,
    device: null,
    tracks: [],
    /** 勾选待移除的曲目 id */
    marked: new Set(),
    /** 本地待导入 */
    pending: [],
    search: '',
    busy: false,
    /** 正在忙的是哪件事：'write' | 'remove' | ''，用于给对应按钮显示进度文案 */
    busyMode: '',
    voiceoverSupported: false,
    /** 语音后端诊断结果 */
    tts: null,
    /** 刚走过「安全弹出」：随后的断开通知要换成更贴切的说法 */
    ejected: false,
  };

  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- 工具

  function fmtBytes(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
  }

  function fmtDuration(ms) {
    if (!ms || ms <= 0) return '--:--';
    const t = Math.round(ms / 1000);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    const p = (x) => String(x).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  }

  function setStatus(text, kind) {
    const el = $('status');
    el.textContent = text || '';
    el.className = `status${kind ? ` ${kind}` : ''}`;
  }

  // ---------------------------------------------------------------- 设备

  async function refreshDevices() {
    setStatus('正在检测设备…');
    let list = [];
    try {
      list = await api.listDevices();
    } catch (e) {
      setStatus(`检测失败：${e.message}`, 'err');
      return;
    }
    const usable = list.filter((d) => d && !d.error);
    if (usable.length === 0) {
      state.root = null;
      state.device = null;
      state.tracks = [];
      renderDeviceHeader();
      renderDevice();
      renderCapacity();
      renderActionBar();
      setStatus('未检测到 iPod。请确认设备已插入并处于可写状态。', 'err');
      return;
    }
    await selectDevice(usable[0].root);
  }

  async function selectDevice(root) {
    state.root = root;
    await loadDevice();
  }

  async function loadDevice() {
    if (!state.root) return;
    try {
      const [devices, lib] = await Promise.all([
        api.listDevices(),
        api.loadLibrary(state.root),
      ]);
      const d = (devices || []).find((x) => x && x.root === state.root);
      if (!d) {
        // 两次调用之间设备被拔掉了（用户也可能是在设备已拔出后点了「刷新」）。
        // 必须在这里收口，否则下面的 state.device.__missing 会对 null 赋值，
        // 抛出的 TypeError 被 catch 成一句看不懂的"读取设备失败"，而界面上
        // 旧的设备信息还留在那里 —— 看上去就像设备还在。
        handleDeviceGone();
        setStatus('iPod 已断开，设备信息已清空。', 'err');
        return;
      }
      state.device = d;
      state.tracks = lib.tracks || [];
      state.voiceoverSupported = !!lib.voiceoverSupported;
      // 重读曲库后，按**实际还在的曲目**重新核对勾选，而不是一律清空：
      //   · 移除流程：删掉的曲子已不在列表里，勾选自然落空（等价于清空）
      //   · 写入流程：设备曲目根本没动，勾选就得原样留着 —— 否则点一次「写入」
      //     会顺手抹掉用户刚勾好的待删列表，两个按钮又缠在一起了
      const alive = new Set(state.tracks.map((t) => t.id));
      state.marked = new Set([...state.marked].filter((id) => alive.has(id)));
      state.device.__missing = lib.missingFiles;
      state.device.__orphan = lib.orphanFiles;
      state.device.__voEnabled = lib.voiceoverEnabled;

      renderDeviceHeader();
      renderDevice();
      renderCapacity();
      renderActionBar();

      const n = state.tracks.length;
      setStatus(`已读取设备曲库：${n} 首。`);
    } catch (e) {
      setStatus(`读取设备失败：${e.message}`, 'err');
    }
  }

  // ---------------------------------------------------------------- 设备热插拔

  /**
   * 清空一切与设备相关的状态。拔线、或读取时发现设备已不在，都走这里。
   *
   * 针对该设备的「待移除」标记一并作废：设备都不在了，这些标记既写不进设备
   * 也没法核对，留着只会在下次接入时变成一颗定时炸弹。
   * 左侧「本地音乐」列表**不动** —— 它属于本机，与设备无关。
   *
   * 返回被作废的标记数量，供调用方决定提示语气。
   */
  function handleDeviceGone() {
    const dropped = state.marked.size;
    state.root = null;
    state.device = null;
    state.tracks = [];
    state.marked = new Set();
    renderDeviceHeader();
    renderDevice();
    renderCapacity();
    renderActionBar();
    return dropped;
  }

  /**
   * 主进程每秒探一次设备是否在位（说明见 main/index.ts），只有状态真的变化才通知。
   *
   * 这里只处理"变化"：插入 → 自动选中并读取曲库；拔出 → 立刻清空设备相关内容。
   * 少了这一步，拔线后界面会一直停在旧数据上，看上去像设备还在。
   */
  async function onDeviceChanged(root) {
    // 正在写入/移除时不抢状态：设备中途被拔，写入流程自己会失败并报错，
    // 这里再插一脚只会把错误信息冲掉。
    if (state.busy) return;

    if (!root) {
      if (!state.root && !state.device) return; // 本来就是"无设备"，无需处理
      const dropped = handleDeviceGone();
      if (state.ejected) {
        state.ejected = false;
        setStatus('已安全弹出，现在可以拔线了。', 'ok');
      } else {
        setStatus(
          dropped
            ? `iPod 已断开，已作废 ${dropped} 首待移除标记（这些改动没有写入设备）。`
            : 'iPod 已断开，设备信息已清空。',
          dropped ? 'err' : '',
        );
      }
      return;
    }

    if (root === state.root && state.device) return; // 同一台设备，不必重读
    state.ejected = false;
    await selectDevice(root); // 状态文案由 loadDevice 给出（"已读取设备曲库：N 首"）
  }

  function renderDeviceHeader() {
    const slot = $('deviceSlot');
    const d = state.device;
    if (!d) {
      slot.innerHTML =
        '<div class="device-empty"><span class="dot dot-off"></span><span>未检测到设备</span>' +
        '<button class="btn btn-ghost btn-sm" id="btnRefresh">重新检测</button></div>';
      $('btnRefresh').onclick = () => refreshDevices();
      return;
    }

    const voTag = !state.voiceoverSupported
      ? '<span class="tag warn">不支持 VoiceOver</span>'
      : d.__voEnabled
        ? '<span class="tag">VoiceOver 已开启</span>'
        : '<span class="tag warn">VoiceOver 已关闭</span>';

    slot.innerHTML = `
      <div class="device-card">
        <div>
          <div class="device-name">
            <span class="dot dot-on" style="display:inline-block;margin-right:7px"></span>
            ${esc(d.volumeLabel || 'iPod Shuffle')}
          </div>
          <div class="device-sub">${esc(d.driveLetter)} · 第 4 代 · FAT32</div>
        </div>
        <div class="device-stat">
          <div class="stat"><b>${d.trackCount}</b><span>曲目</span></div>
          <div class="stat"><b>${fmtBytes(d.freeBytes)}</b><span>可用</span></div>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          ${voTag}
          <button class="btn btn-ghost btn-sm" id="btnRefresh">刷新</button>
        </div>
      </div>`;
    $('btnRefresh').onclick = () => loadDevice();
  }

  function visibleTracks() {
    const q = state.search.trim().toLowerCase();
    if (!q) return state.tracks.map((t, i) => ({ t, i }));
    return state.tracks
      .map((t, i) => ({ t, i }))
      .filter(
        ({ t }) =>
          t.title.toLowerCase().includes(q) ||
          t.artist.toLowerCase().includes(q) ||
          t.album.toLowerCase().includes(q),
      );
  }

  function renderDevice() {
    const list = $('deviceList');
    $('deviceCount').textContent = String(state.tracks.length);
    const rows = visibleTracks();

    if (state.tracks.length === 0) {
      list.innerHTML =
        '<li class="empty"><b>设备上没有曲目</b>从左侧拖入音乐，然后点「写入 iPod」</li>';
      return;
    }
    if (rows.length === 0) {
      list.innerHTML = '<li class="empty">没有匹配的曲目</li>';
      return;
    }

    list.innerHTML = rows
      .map(({ t }) => {
        const marked = state.marked.has(t.id);
        const srcLabel =
          t.source === 'id3'
            ? null
            : t.source === 'itunesdb'
              ? '取自 iTunesDB'
              : t.source === 'imported'
                ? '导入时记录'
                : '文件名';
        const vo = t.hasVoiceover
          ? '<span class="badge vo">语音</span>'
          : state.voiceoverSupported
            ? '<span class="badge vo-off">无语音</span>'
            : '';
        const gone = t.exists
          ? ''
          : '<span class="badge err" title="数据库里还有这条记录，但文件已经不在了。下次写入时会自动清除这条记录。">文件丢失 · 待自动清除</span>';
        return `
          <li class="row ${marked ? 'marked' : ''}" data-id="${esc(t.id)}">
            <input class="check" type="checkbox" ${marked ? 'checked' : ''} title="勾选 = 从设备移除这一首" />
            <div class="row-main">
              <div class="row-title">${esc(t.title)}</div>
              <div class="row-meta">${esc(t.artist || '未知艺术家')}${
                t.album ? ` · ${esc(t.album)}` : ''
              } · ${esc(t.filename)}</div>
            </div>
            <div class="row-badges">
              ${gone}
              <span class="badge">${esc(t.format)}</span>
              ${srcLabel ? `<span class="badge src">${srcLabel}</span>` : ''}
              ${vo}
            </div>
            <div class="row-time">${fmtDuration(t.durationMs)}</div>
          </li>`;
      })
      .join('');

    list.querySelectorAll('.row').forEach((el) => {
      const id = el.dataset.id;
      const toggle = () => {
        if (state.marked.has(id)) state.marked.delete(id);
        else state.marked.add(id);
        renderDevice();
        renderCapacity();
        renderActionBar();
      };
      el.querySelector('.check').onclick = (ev) => {
        ev.stopPropagation();
        toggle();
      };
      el.onclick = toggle;
    });
  }

  // ---------------------------------------------------------------- 本地待导入

  function renderLocal() {
    const list = $('localList');
    $('localCount').textContent = String(state.pending.length);
    list.innerHTML = state.pending
      .map((p, i) => {
        const bad = p.error
          ? `<span class="badge err">不支持</span>`
          : `<span class="badge">${esc(p.format)}</span>`;
        return `
          <li class="row pending" data-i="${i}">
            <div class="row-main">
              <div class="row-title">${esc(p.title)}</div>
              <div class="row-meta">${esc(p.artist || '未知艺术家')} · ${esc(p.fileName)}${
                p.error ? ` · ${esc(p.error)}` : ''
              }</div>
            </div>
            <div class="row-badges">${bad}</div>
            <div class="row-time">${
              p.error ? '—' : fmtDuration(p.durationMs)
            }</div>
            <button class="icon-btn remove" title="移除">
              <svg viewBox="0 0 24 24" width="15" height="15">
                <path d="M7 7l10 10M17 7L7 17" stroke="currentColor" stroke-width="1.8"
                      stroke-linecap="round" fill="none" />
              </svg>
            </button>
          </li>`;
      })
      .join('');

    list.querySelectorAll('.row').forEach((row) => {
      const i = Number(row.dataset.i);
      const del = row.querySelector('.icon-btn.remove');
      if (del) {
        del.onclick = (ev) => {
          ev.stopPropagation();
          state.pending.splice(i, 1);
          renderLocal();
          renderCapacity();
          renderActionBar();
        };
      }
    });

    $('dropzone').classList.toggle('compact', state.pending.length > 0);
  }

  async function addInputs(paths) {
    if (!paths || paths.length === 0) return;
    setStatus('正在解析音频文件…');
    try {
      const expanded = await api.expandInputs(paths);
      if (expanded.length === 0) {
        setStatus('没有找到可导入的音频文件（支持 MP3 / M4A）。', 'err');
        return;
      }
      const already = new Set(state.pending.map((p) => p.path.toLowerCase()));
      const fresh = expanded.filter((p) => !already.has(p.toLowerCase()));
      const inspected = await api.inspectFiles(fresh);
      state.pending = state.pending.concat(inspected);
      renderLocal();
      renderCapacity();
      renderActionBar();
      const bad = inspected.filter((p) => p.error).length;
      setStatus(
        `已加入 ${inspected.length} 首` + (bad ? `（其中 ${bad} 首无法导入，将被跳过）` : '。'),
        bad ? 'err' : 'ok',
      );
    } catch (e) {
      setStatus(`添加失败：${e.message}`, 'err');
    }
  }

  // ---------------------------------------------------------------- 容量

  function renderCapacity() {
    const el = $('capacity');
    const d = state.device;
    if (!d) {
      el.innerHTML = '';
      return;
    }
    const total = d.totalBytes || 1;
    const used = Math.max(0, total - d.freeBytes);
    const music = Math.min(d.usedByMusicBytes || 0, used);
    const other = Math.max(0, used - music);
    const free = Math.max(0, d.freeBytes);

    const pendingBytes = state.pending.reduce((s, p) => s + (p.error ? 0 : p.fileSize), 0);
    const needVoice = state.tracks.filter(
      (t) => !state.marked.has(t.id) && !t.hasVoiceover,
    ).length + state.pending.filter((p) => !p.error).length;
    const voiceBytes = $('optVoiceover').checked ? needVoice * 200 * 1024 : 0;

    const pct = (n) => `${(n / total) * 100}%`;

    el.innerHTML = `
      <div class="cap-head">
        <span>设备容量</span>
        <span>已用 ${fmtBytes(used)} / ${fmtBytes(total)} · 可用 ${fmtBytes(free)}</span>
      </div>
      <div class="cap-bar">
        <div class="cap-seg cap-music" style="width:${pct(music)}"></div>
        <div class="cap-seg cap-other" style="width:${pct(other)}"></div>
      </div>
      <div class="cap-legend">
        <span><i style="background:linear-gradient(90deg,#5566f5,#37cbe0)"></i>音乐 ${fmtBytes(
          music,
        )}</span>
        <span><i style="background:#dfe4f2"></i>其他 ${fmtBytes(other)}</span>
        ${
          pendingBytes + voiceBytes > 0
            ? `<span><i style="background:rgba(224,87,107,.7)"></i>本次待写入 ${fmtBytes(
                pendingBytes + voiceBytes,
              )}</span>`
            : ''
        }
      </div>`;
  }

  // ---------------------------------------------------------------- 底栏

  function renderActionBar() {
    const addCount = state.pending.filter((p) => !p.error).length;
    const rmCount = state.marked.size;
    // 一致性清理（清失效记录 / 删未登记文件）本质是「从设备上拿掉东西」，
    // 归到移除按钮；写入按钮只管把本地音乐送进去，永远不删设备上的任何文件。
    const ghost = state.device?.__missing ?? 0;
    const orphan = state.device?.__orphan ?? 0;
    const cleanups = [];
    if (ghost) cleanups.push(`清除 ${ghost} 条失效记录`);
    if (orphan) cleanups.push(`清理 ${orphan} 个未登记文件`);

    // 设备上已经存在、却没有对应语音文件的曲目（典型成因：写入当时 TTS 后端不可用）。
    // 写入流程本来就只补「缺的那几首」（sync 会遍历全部曲目、已有语音直接跳过），
    // 所以当本地没有新歌要写时，这个按钮退化成「补齐语音」，而不是灰着不让点。
    const missingVoice =
      state.voiceoverSupported && $('optVoiceover').checked
        ? state.tracks.filter((t) => t.exists && !t.hasVoiceover).length
        : 0;

    // 状态栏也分两笔报账，否则「待写入」会把删除意图混进去，又回到混淆的老问题
    if (!state.busy) {
      const bits = [];
      if (addCount) bits.push(`待写入 ${addCount} 首`);
      if (rmCount) bits.push(`已标记移除 ${rmCount} 首`);
      if (missingVoice) bits.push(`待补语音 ${missingVoice} 首`);
      if (cleanups.length) bits.push(`待清理 ${cleanups.join('、')}`);
      if (bits.length === 0) {
        setStatus(state.root ? '没有待处理的变更。' : '未检测到设备。');
      } else {
        setStatus(`${bits.join(' · ')}。`);
      }
    }

    const writeBusy = state.busy && state.busyMode === 'write';
    const removeBusy = state.busy && state.busyMode === 'remove';

    // 「写入 iPod」：只增不减，非破坏性，不需要二次确认。
    // 没有新歌可写、但设备上有曲目缺语音时，同一个按钮负责「补齐语音」——
    // 底层是同一个 sync 流程，不额外增加按钮和参数分支。
    const canWrite = !state.busy && !!state.root && (addCount > 0 || missingVoice > 0);
    $('btnWrite').disabled = !canWrite;
    $('btnWrite').textContent = writeBusy
      ? '正在写入…'
      : addCount
        ? `写入 iPod（${addCount} 首）`
        : missingVoice
          ? `补齐语音（${missingVoice} 首）`
          : '写入 iPod';

    // 「移除」：删勾选的曲目；没有勾选时退化成「清理设备上的冗余」
    const canRemove = !state.busy && !!state.root && (rmCount > 0 || cleanups.length > 0);
    $('btnRemove').disabled = !canRemove;
    $('btnRemove').textContent = removeBusy
      ? '正在移除…'
      : rmCount
        ? `移除 ${rmCount} 首`
        : cleanups.length
          ? '清理设备'
          : '移除所选';

    $('btnEject').disabled = !state.root || state.busy;
    $('btnAddFiles').disabled = state.busy;
    $('btnAddFolder').disabled = state.busy;
  }

  function setBusy(on, mode) {
    state.busy = on;
    state.busyMode = on ? mode || '' : '';
    renderActionBar();
    $('progress').hidden = !on;
    if (!on) {
      $('progressFill').style.width = '0';
      $('progressText').textContent = '';
    }
  }

  // ---------------------------------------------------------------- 执行

  /**
   * 两个按钮共用同一个执行入口，区别只在**传什么、不传什么**：
   *
   *   mode='write'  只把本地待导入的曲子送进设备 —— addSources 有值，
   *                 removeIds 恒为空、pruneOrphans 恒为 false，任何情况下
   *                 都不会删掉设备上已有的东西。
   *   mode='remove' 只处理「已勾选移除 + 一致性清理」—— addSources 恒为空，
   *                 不会因为顺手点一下就多写进几首歌。
   *
   * 分开的另一个好处：做完一件事只清掉对应那笔待办（写入清左侧清单、
   * 移除清勾选），另一边的选择原封不动。
   *
   * @param mode 'write' | 'remove'
   */
  async function runSync(mode) {
    if (!state.root || state.busy) return;
    const isWrite = mode === 'write';
    const adds = isWrite ? state.pending.filter((p) => !p.error).map((p) => p.path) : [];
    const removes = isWrite ? [] : [...state.marked];
    const skipped = isWrite ? state.pending.filter((p) => p.error).length : 0;

    setBusy(true, isWrite ? 'write' : 'remove');
    setStatus(isWrite ? '正在写入…' : '正在移除…');
    const off = api.onProgress((p) => {
      const pct = p.total > 0 ? Math.round((p.current / p.total) * 100) : 0;
      $('progressFill').style.width = `${pct}%`;
      $('progressText').textContent = p.message || '';
    });

    try {
      const res = await api.runSync(state.root, {
        addSources: adds,
        removeIds: removes,
        generateVoiceover: isWrite && $('optVoiceover').checked,
        enableVoiceover: isWrite && $('optVoiceover').checked,
        skipDuplicates: isWrite && $('optSkipDup').checked,
        // 清理孤儿是删文件，只在「移除」流程里做 —— 写入按钮永不删设备上的东西。
        // （失效记录属于「数据库登记了不存在的文件」，两种流程里都会被顺手修掉，
        //   那是修复登记、不是删文件，与这里的开关无关。）
        pruneOrphans: !isWrite,
      });
      off();
      setBusy(false);

      if (res && res.ok === false) {
        showDialog(isWrite ? '写入未完成' : '移除未完成', `<p>${esc(res.message)}</p>`);
        setStatus(
          res.kind === 'space'
            ? '空间不足，未做任何改动。'
            : isWrite
              ? '写入失败。'
              : '移除失败。',
          'err',
        );
        return;
      }

      // 只清掉这次真正处理掉的那笔待办
      if (isWrite) state.pending = [];
      else state.marked.clear();
      await loadDevice();
      renderLocal();
      showResult(res, skipped, mode);
    } catch (e) {
      off();
      setBusy(false);
      showDialog(isWrite ? '写入异常' : '移除异常', `<p>${esc(e.message)}</p>`);
      setStatus(isWrite ? '写入异常。' : '移除异常。', 'err');
    }
  }

  function showResult(res, skippedUnsupported, mode) {
    const isWrite = mode === 'write';
    const warnings = (res.warnings || []).slice();
    if (skippedUnsupported > 0) {
      warnings.push(`有 ${skippedUnsupported} 首因格式不支持被跳过。`);
    }
    // 一致性清理（保持「数据库记录 ≡ 设备上实际歌曲」）：只在真的发生时显示
    const cleanRows = [];
    if (res.ghostPruned > 0) {
      cleanRows.push(
        `<div>清除失效记录</div><div><b>${res.ghostPruned}</b> 条（文件已不存在）</div>`,
      );
    }
    if (res.orphanRemoved > 0) {
      cleanRows.push(
        `<div>删除未登记音频</div><div><b>${res.orphanRemoved}</b> 个（数据库未引用，设备本来也播不到）</div>`,
      );
    }
    if (res.orphanVoiceRemoved > 0) {
      cleanRows.push(`<div>删除无主语音</div><div><b>${res.orphanVoiceRemoved}</b> 个</div>`);
    }
    if (res.orphanKept > 0) {
      cleanRows.push(
        `<div>保留未清理</div><div><b style="color:var(--danger)">${res.orphanKept}</b> 个（清理失败，详见下方提示）</div>`,
      );
    }
    // 只报这次真正做过的事，免得「写入完成」里出现一行「移除曲目 0 首」反而让人犯嘀咕
    const mainRows = isWrite
      ? [`<div>新增曲目</div><div><b>${res.added}</b> 首</div>`]
      : [`<div>移除曲目</div><div><b>${res.removed}</b> 首</div>`];
    if (isWrite) {
      mainRows.push(
        `<div>新生语音</div><div><b>${res.voiceoverCreated}</b> 个（已有 ${res.voiceoverSkipped} 个，无需重做）</div>`,
      );
    }
    const body = `
      <div class="kv">
        ${mainRows.join('')}
        <div>写入字节</div><div><b>${fmtBytes(res.bytesWritten)}</b></div>
        <div>数据库备份</div><div>${res.backupPath ? esc(res.backupPath) : '—'}</div>
        ${cleanRows.join('')}
      </div>
      ${
        warnings.length
          ? `<div class="warn-list"><b>提示</b><ul>${warnings
              .map((w) => `<li>${esc(w)}</li>`)
              .join('')}</ul></div>`
          : ''
      }
      <p style="margin-top:14px">
        <b>下一步：点底栏「安全弹出」再拔线。</b>
        FAT32 有写缓存，不刷盘就断开，设备会读到旧数据库。
      </p>`;
    showDialog(isWrite ? '写入完成' : '移除完成', body, '确定');
  }

  async function doEject() {
    if (!state.root) return;
    setStatus('正在安全弹出…');
    const ok = await api.eject(state.root);
    if (ok) {
      // 标记一下：随后主进程推来的"设备已断开"要用更贴切的说法，
      // 否则用户刚看到"可以拔线了"，紧接着又被一句"iPod 已断开"吓一跳。
      state.ejected = true;
      setStatus('已安全弹出，现在可以拔线了。', 'ok');
      // 不再手动 refreshDevices()：设备卸载后主进程的探测会推来断开通知，
      // 手动刷一次反而会立刻用"未检测到 iPod"盖掉上面这句提示。
    } else {
      setStatus('自动弹出失败，请手动右键设备图标选择「弹出」。', 'err');
      showDialog(
        '未能自动弹出',
        '<p>请在「此电脑」中右键该设备，选择 <b>弹出</b>，待指示灯停止闪烁后再拔线。</p>',
      );
    }
  }

  // ---------------------------------------------------------------- 弹层

  function closeDialog() {
    $('overlay').hidden = true;
  }

  /**
   * @param opts.cancelText 传入时才显示「取消」按钮（破坏性操作必须传）
   * @param opts.okClass    确认按钮样式，破坏性操作用 'btn btn-danger'
   */
  function showDialog(title, html, okText, onOk, opts = {}) {
    $('dialogTitle').textContent = title;
    $('dialogBody').innerHTML = html;

    const ok = $('dialogOk');
    ok.textContent = okText || '确定';
    ok.className = opts.okClass || 'btn btn-primary';
    ok.onclick = () => {
      closeDialog();
      onOk?.();
    };

    const cancel = $('dialogCancel');
    cancel.hidden = !opts.cancelText;
    cancel.textContent = opts.cancelText || '取消';
    cancel.onclick = () => {
      closeDialog();
      opts.onCancel?.();
    };

    $('overlay').hidden = false;
  }

  // ---------------------------------------------------------------- 事件绑定

  function bindEvents() {
    $('btnRefresh').onclick = () => refreshDevices();
    $('btnAddFiles').onclick = async () => {
      const paths = await api.pickFiles();
      await addInputs(paths);
    };
    $('btnAddFolder').onclick = async () => {
      const dir = await api.pickFolder();
      if (dir) await addInputs([dir]);
    };
    $('btnClearLocal').onclick = () => {
      state.pending = [];
      renderLocal();
      renderCapacity();
      renderActionBar();
    };
    $('btnSelectAll').onclick = () => {
      for (const t of visibleTracks()) state.marked.add(t.t.id);
      renderDevice();
      renderCapacity();
      renderActionBar();
    };
    $('btnSelectNone').onclick = () => {
      state.marked.clear();
      renderDevice();
      renderCapacity();
      renderActionBar();
    };
    // 「写入 iPod」：只增不减，属于非破坏性操作，点一下就执行
    $('btnWrite').onclick = () => {
      void runSync('write');
    };

    // 「移除 / 清理设备」：删除是不可逆的 —— 曲目文件与语音文件直接抹掉，
    // 本工具不做音频备份（只有 iTunesSD 会自动备份）。所以一律先过确认框。
    $('btnRemove').onclick = () => {
      const removing = state.tracks.filter((t) => state.marked.has(t.id));
      const ghost = state.device?.__missing ?? 0;
      const orphan = state.device?.__orphan ?? 0;

      if (removing.length === 0 && ghost === 0 && orphan === 0) return;

      if (removing.length === 0) {
        // 纯清理：没有勾选任何曲目，但会删掉数据库未登记的文件
        showDialog(
          '确认清理设备上的冗余文件？',
          `<p>本次没有标记移除任何曲目，但会做一次一致性清理，让数据库登记与设备实际文件完全一致：</p>
           ${
             ghost
               ? `<div class="pick-list"><div>清除 <b>${ghost}</b> 条失效记录（文件已不存在，设备本来也点不响）</div></div>`
               : ''
           }
           ${
             orphan
               ? `<div class="pick-list"><div>删除 <b>${orphan}</b> 个未登记文件（数据库没有引用，设备本来也播不到）</div></div>`
               : ''
           }
           <p style="margin-top:12px">删除的只是设备上的冗余副本，<b>不会动到曲库里的任何一首歌</b>。</p>`,
          `确认清理`,
          () => void runSync('remove'),
          { okClass: 'btn btn-danger', cancelText: '取消' },
        );
        return;
      }

      const shown = removing.slice(0, 10);
      const list = shown.map((t) => `<div>${esc(t.title)}</div>`).join('');
      const more =
        removing.length > shown.length
          ? `<div class="pick-more">…以及另外 ${removing.length - shown.length} 首</div>`
          : '';
      const voiceCount = removing.filter((t) => t.hasVoiceover).length;
      const extra = [];
      if (ghost) extra.push(`清除 ${ghost} 条失效记录`);
      if (orphan) extra.push(`删除 ${orphan} 个未登记文件`);
      showDialog(
        `确认从 iPod 移除 ${removing.length} 首？`,
        `<p>以下曲目会从设备上<b>永久删除</b>${
          voiceCount ? `，连同 ${voiceCount} 个 VoiceOver 语音文件` : ''
        }：</p>
         <div class="pick-list">${list}${more}</div>
         ${
           extra.length
             ? `<p style="margin-top:12px">同时会做一致性清理：${extra.join('、')}。</p>`
             : ''
         }
         <p style="margin-top:12px">数据库改动前会自动备份，但<b>音频与语音文件不做备份</b>，删掉无法找回。</p>`,
        `确认移除 ${removing.length} 首`,
        () => void runSync('remove'),
        { okClass: 'btn btn-danger', cancelText: '取消' },
      );
    };
    $('btnEject').onclick = doEject;
    // 关掉「生成中文 VoiceOver」后，「补齐语音」这个退化文案要立刻消失
    $('optVoiceover').onchange = () => {
      renderCapacity();
      renderActionBar();
    };

    $('search').oninput = (e) => {
      state.search = e.target.value;
      renderDevice();
    };

    // 拖放
    const dz = $('dropzone');
    const stop = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    ['dragenter', 'dragover'].forEach((ev) =>
      document.addEventListener(ev, (e) => {
        stop(e);
        dz.classList.add('hot');
      }),
    );
    ['dragleave', 'drop'].forEach((ev) =>
      document.addEventListener(ev, (e) => {
        stop(e);
        if (ev === 'drop' || e.target === document.documentElement) dz.classList.remove('hot');
      }),
    );
    document.addEventListener('drop', async (e) => {
      const files = Array.from(e.dataTransfer?.files || []);
      const paths = files.map((f) => {
        try {
          return api.pathForFile(f);
        } catch {
          return '';
        }
      });
      await addInputs(paths.filter(Boolean));
    });

    $('overlay').addEventListener('click', (e) => {
      if (e.target === $('overlay')) closeDialog();
    });
  }

  // ---------------------------------------------------------------- 启动

  /**
   * 探测语音合成后端。
   *
   * 有必要显式展示：本机实测存在**PowerShell 被安全策略拦截**的情况
   * （启动直接返回「拒绝访问」），此时程序会自动退回 Python 后端。
   * 用户应当知道现在走的是哪条路，而不是遇到"开关打开却没声音"。
   */
  async function loadTtsDiagnostics() {
    const tag = $('voBackend');
    const input = $('optVoiceover');
    const wrap = input.closest('.switch');
    let d = null;
    try {
      d = await api.ttsDiagnostics();
    } catch {
      d = null;
    }
    state.tts = d;

    if (!d || !d.backend) {
      tag.textContent = '语音后端不可用';
      tag.className = 'tag warn';
      input.checked = false;
      input.disabled = true;
      wrap.title = (d && d.error) || '未检测到可用的语音合成后端';
      return;
    }
    const voice = (d.voices || []).find(
      (v) => /^zh/i.test(v.culture || '') || /huihui|chinese|xiaoxiao|yaoyao/i.test(v.name),
    );
    const shortName = voice ? voice.name.replace(/^Microsoft\s+/, '').split(' - ')[0] : d.backend;
    tag.textContent = `语音：${shortName}`;
    tag.className = 'tag';
    input.disabled = false;
    wrap.title =
      `后端：${d.backend}` +
      (d.backend === 'python' ? '（PowerShell 不可用，已自动降级）' : '') +
      (d.error ? ` — ${d.error}` : '');
  }

  // 界面自检（scripts/verify-ui.js）需要一个入口，才能在不插设备的情况下
  // 伪造「数据库有失效记录 / Music 有孤儿文件」这两种状态，验证一致性清理的
  // 守门逻辑；以及手动投递设备插拔事件，验证热插拔后界面是否正确收敛。
  // 只暴露状态对象与重绘函数，正常使用完全不会碰到。
  //
  // `api` 也一并暴露：自检要能替换掉 runSync 来**捕获真正传给主进程的参数**，
  // 从而证明「写入」这一路绝不携带 removeIds / pruneOrphans（这才是
  // 「两个按钮互不越界」的可验证证据，光看按钮文案说明不了）。
  window.__ipodUi = {
    state,
    api,
    renderActionBar,
    renderDevice,
    renderCapacity,
    renderLocal,
    onDeviceChanged,
  };

  window.addEventListener('DOMContentLoaded', async () => {
    bindEvents();
    if (api.__pending) state.pending = api.__pending;
    renderLocal();
    renderCapacity();
    renderActionBar();
    await loadTtsDiagnostics();
    // 先订阅再初次检测：两者之间若发生插拔，不至于被漏掉。
    // 插入/拔出后主进程会主动推来 device:changed，界面据此即时更新。
    if (typeof api.onDeviceChange === 'function') {
      api.onDeviceChange((root) => {
        void onDeviceChanged(root);
      });
    }
    await refreshDevices();
    console.info(
      `[Shuffle 管家] 界面就绪 — 设备 ${state.root ?? '未连接'}，` +
        `曲目 ${state.tracks.length}，待导入 ${state.pending.length}，` +
        `语音后端 ${state.tts?.backend ?? '不可用'}`,
    );
    if (api.__preview) {
      setStatus('预览模式：界面演示数据，未连接真实设备。', '');
    }
  });
})();
