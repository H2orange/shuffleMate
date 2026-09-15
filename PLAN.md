# iPod Shuffle 音乐管理工具 — 实施计划

> 状态：可行性已验证（本机 F: 盘实机取数 + 二进制往返比对通过）
> 日期：2026-09-15

---

## 0. 结论摘要

| 问题 | 结论 |
| --- | --- |
| 能否做一个往 iPod 增删歌曲的软件？ | **能，且风险很低** |
| 最大的坑是什么？ | 不是签名/加密，而是「你以为要改 iTunesDB，其实要改 iTunesSD」 |
| 需要破解 Apple 的校验吗？ | **不需要**。shuffle 的播放数据库无哈希签名 |
| 元数据从哪来？ | 从音频文件自身的 ID3/MP4 标签读，与 iPod 无关 |
| 格式掌握程度 | **已用设备上 Apple 生成的原文件做逐字节往返重建，完全一致** |

---

## 1. 本机设备实测档案

| 项 | 值 |
| --- | --- |
| 盘符 / 卷标 | `F:` (X317) |
| 容量 | 2 GB 标称，1.87 GB 可用，已占用约 290 MB |
| 文件系统 | FAT32（Windows 可读写） |
| 曲目数 | 13（`Music/F00`×6、`F01`×5、`F02`×2） |
| 音乐文件名 | 4 字符随机名，如 `SBJT.mp3`、`DQMD.mp3` |
| 音频格式 | 全部 MP3，时长 1496–2082 秒（约 25–35 分钟，疑似有声书/播客） |
| VoiceOver | 已启用（根头第 29 字节 = 1；`iPod_Control/Speakable/Tracks/` 下有 13 个 wav） |
| 数据库版本标记 | `iTunesSD` 根头 `unknown1 = 0x02010001` |

目录结构：

```
F:\
└── iPod_Control\
    ├── Music\            F00 / F01 / F02 —— 音频文件本体
    ├── iTunes\
    │   ├── iTunesSD      ★ 播放数据库（真正要改的文件，5140 B）
    │   ├── iTunesDB      Apple 自己记账用，shuffle 播放时不读（21836 B）
    │   ├── iTunesPState / iTunesPrefs / iTunesStats / iTunesControl
    ├── Speakable\        语音播报（VoiceOver）—— 注意在 iPod_Control 之内
    │   ├── Tracks\       每首歌一个 wav，文件名 = dbid 的倒序 hex
    │   ├── Playlists\ / Messages\ / System\ + 30 个语言 .plist
    │   └── VoiceOverDB   VoiceOver Kit 音色清单，**不要动**
    └── Device\PData      设备私有数据，**永不触碰**
```

---

## 2. 四个关键发现

### 2.1 shuffle 播放读的是 `iTunesSD`，不是 `iTunesDB`

这是本项目最关键的一点。经典 iPod（Classic/Nano）用 `iTunesDB`（`mhbd/mhsd/mhit/mhod` 体系），但 shuffle 用的是独立简化格式 `iTunesSD`（文件头 `bdhs`，即 "shdb" 倒写）。

社区里所有可用的第三方方案（`ipod-shuffle-4g`、`create-ipod-database` 等）**都只写 `iTunesSD`**，不碰 `iTunesDB`。我们沿用同样策略。

### 2.2 无需签名 / 哈希

经典 iPod 和 Nano 写入数据库时要在特定偏移填一个由设备序列号（FireWire GUID）派生的加密哈希（hash58/hash72/hashAB），这是社区工具最大的门槛。**shuffle 没有这个校验** —— 纯 Python 脚本就能重建数据库并正常播放，这是本方案能纯软件实现的原因。

### 2.3 文件名随机，但元数据在文件里

`Music/` 下的文件名是 iTunes 随机生成的 4 字符码。真实曲名/艺术家/专辑存在两处：

1. 音频文件内部的 **ID3v2 / MP4 atom 标签** ← **我们软件显示名称就靠它**
2. 数据库内的 `albumid` / `artistid` 索引

结论：软件的曲名显示**完全由 ID3 标签驱动**，不需要解析 Apple 的数据库。这也正是 Windows 资源管理器显示乱码而我们的软件能显示正常名称的原因。

### 2.4 VoiceOver 机制（已实机验证，完整）

shuffle 没有屏幕，**VoiceOver 是唯一能"知道正在放哪首歌"的方式**，因此这是核心功能。

**总开关**：`iTunesSD` 根头第 29 字节（`voiceover_enabled`）。本机 Apple 原值 = `1`，
重建数据库时必须**原样保留**，置 0 会导致整机静音（连系统提示音都不播）。
注意它是**全局开关**，不是逐曲开关。

**单曲语音**：`iPod_Control/Speakable/Tracks/<文件名>.wav`，文件名 = 该曲目 `dbid`
（8 字节）**字节倒序后的十六进制大写**。文件存在 → 播报；不存在 → 静音（设备不报错）。

> ⚠️ **路径易错点**：`Speakable` 位于 **`iPod_Control/` 之内**，不在 iPod 根目录下。
> 实机确认的完整结构：
> ```
> iPod_Control/Speakable/
>   ├── Tracks/        曲目语音（我们写入的地方）
>   ├── Playlists/     播放列表语音
>   ├── System/        系统提示音（9 个，只读）
>   ├── Messages/      电池/错误等提示（24 个，只读）
>   ├── VoiceOverDB    6712 B，VoiceOver Kit 的音色清单（Nuance 引擎
>   │                  zh_CN→Mei-Ling / yue_CN→Sin-Ji 等 33 种），**不要动**
>   └── *.plist        30 个语言配置（含 zh-CN.plist、yue-CN.plist）
> ```

实测对应关系（**13/13 全部命中**，用设备 13 首逐一核对）：

| 曲目 | dbid（原始字节序） | VoiceOver 文件 |
| --- | --- | --- |
| F00/SBJT.mp3 | `5cda284d1d1a1083` | `83101A1D4D28DA5C.wav` |
| F00/VQCA.mp3 | `f1e475dbb5ab6fc0` | `C06FABB5DB75E4F1.wav` |
| F02/DQMD.mp3 | `b2861d8e90e29c20` | `209CE2908E1D86B2.wav` |
| F01/NEPE.mp3 | `d89f0ff033b915f6` | `F615B933F00F9FD8.wav` |
| F00/YTKZ.mp3 | `a9ab53b7a92376c4` | `C47623A9B753ABA9.wav` |
| F01/WBSM.mp3 | `1b54f7d3b16edec4` | `C4DE6EB1D3F7541B.wav` |
| （其余 7 首同样全部命中） | | |

**dbid 的性质**：逐一测试了 `md5(标题)`、`md5(标题 utf-16le)`、`md5(相对路径)`、
`md5(文件名)`、`md5(冒号路径)`、`md5(路径+标题)` 六种候选公式，**全部 0/13 命中**。
→ **Apple 的 dbid 不是任何可推导的哈希，是不可解释的不透明 ID。**
这意味着：dbid 只是一个"配对标识符"，我们**自定义任何确定性方案都合法**，
只要保证 dbid 与语音文件名成对出现即可。

我们采用的方案（沿用社区 4G 工具，已验证幂等）：

```
dbid = md5(播报文本 UTF-8)[:8]
```

同一首歌重复导入 → dbid 相同 → 语音文件天然复用，不需要额外去重逻辑。
（同批次内若曲名重复会撞车，`voiceover.unique_dbids()` 会追加序号后缀再哈希。）

**音频格式**：不猜，**读取设备上 Apple 现有的语音文件、对齐其格式**。
Apple 用的是 `22050 Hz / 16 bit / 单声道 PCM`，且容器为固定的 4096 字节头，
详见第 11 节。

**播报范围**：`Playlists/` 用于播报播放列表名。主播放列表的 dbid 为全 0 时，
设备使用内置的 "All Songs"，无需我们提供文件。

---

## 3. iTunesSD 二进制格式规范（实测确定）

全部小端（little-endian）。文件 = 根头 + 曲目区 + 播放列表区，区段之间用绝对字节偏移互相引用。

### 3.1 总体布局（以本机 13 曲为例）

```
0x0000  根头 "bdhs"                     64 B  固定
0x0040  曲目头 "hths"                   20 + n×4 B
0x0058  曲目记录 "rths" × n              372 B each
0x136C  播放列表头 "hphs"                72 B  固定
0x13B4  播放列表记录 "lphs" × m          44 + 4×songs B
```

### 3.2 根头 64 字节

| 偏移 | 类型 | 含义 | 本机值 |
| --- | --- | --- | --- |
| 0x00 | 4s | 标识 `bdhs` | — |
| 0x04 | I | 格式版本标记 | `0x02010001` ⚠️ |
| 0x08 | I | 根头长度，固定 64 | 64 |
| 0x0C | I | 曲目总数 | 13 |
| 0x10 | I | 播放列表总数 | 1 |
| 0x14 | Q | 未知，0 | 0 |
| 0x1C | B | 最大音量 | 0 |
| 0x1D | B | **VoiceOver 是否启用** | 1 |
| 0x1E | H | 未知，0 | 0 |
| 0x20 | I | 非播客曲目数 | 13 |
| 0x24 | I | 曲目区偏移，固定 64 | 64 |
| 0x28 | I | 播放列表区偏移 | 4972 |
| 0x2C | 20s | 保留，全 0 | — |

> ⚠️ 社区参考实现写 `0x02000003`，本机 Apple 写 `0x02010001`。两者含义不同（对应不同代数）。
> **对策：不硬编码，读取设备现有文件的值原样沿用。**

### 3.3 曲目头 `hths`（20 + n×4）

| 偏移 | 类型 | 含义 |
| --- | --- | --- |
| 0x00 | 4s | `hths` |
| 0x04 | I | 本段长度 = 20 + n×4 |
| 0x08 | I | 曲目数 n |
| 0x0C | Q | 未知，0 |
| 0x14 | n×I | 每条曲目记录的**绝对文件偏移** |

偏移表紧跟在 20 字节头之后（**注意不是 16 字节**，`unknown1` 是 8 字节的 Q，这里最容易踩坑）。

### 3.4 曲目记录 `rths`（372 = 0x174 字节）

| 偏移 | 类型 | 含义 | 本机实测 |
| --- | --- | --- | --- |
| 0x000 | 4s | `rths` | — |
| 0x004 | I | 本记录长度 0x174 | 372 |
| 0x008 | I | 起始播放位置 ms | 0 |
| 0x00C | I | **时长 ms** | 1496816 |
| 0x010 | I | 音量增益 0–99 | 0 |
| 0x014 | I | **格式：1=MP3，2=AAC/M4A** | 1 |
| 0x018 | 256s | **路径（UTF-8！）**，以 iPod 根为基准，`/` 分隔 | `/iPod_Control/Music/F00/SBJT.mp3` |
| 0x118 | I | bookmark | 0 |
| 0x11C | B | dontskip | 1 |
| 0x11D | B | remember | 0 |
| 0x11E | B | unintalbum | 0 |
| 0x11F | B | 未知 | 0 |
| 0x120 | I | pregap（静音前置） | 528 |
| 0x124 | I | postgap（静音后置） | 780 |
| 0x128 | I | **采样数**（= 时长 × 采样率） | 66008036 |
| 0x12C | I | 未知 | 0 |
| 0x130 | I | 未知（与音频编码相关） | 23954934 |
| 0x134 | I | 未知 | 0 |
| 0x138 | I | **专辑索引** | 138 |
| 0x13C | H | 音轨号 | 0 |
| 0x13E | H | 碟号 | 0 |
| 0x140 | Q | 未知 | 0 |
| 0x148 | 8s | **dbid**（决定 VoiceOver 文件名） | — |
| 0x150 | I | **艺术家索引** | 141 |
| 0x154 | 32s | 保留，全 0 | — |

> ⚠️ 路径字段是 **UTF-8 而非 UTF-16**（这点与经典 iPod 的 iTunesDB 不同），且必须写 `iPod根` 相对路径、以 `/` 分隔。
> ⚠️ `0x120/0x124/0x128/0x130` 由 Apple 按音频内容计算，社区工具一律填 0 也能播。**对策：以设备现有记录为模板生成新记录**，不自己臆造。

### 3.5 播放列表头 `hphs`（实测 72 字节）

| 偏移 | 类型 | 含义 | 本机值 |
| --- | --- | --- | --- |
| 0x00 | 4s | `hphs` | — |
| 0x04 | I | 本段长度 | 72 |
| 0x08 | I | 播放列表数 | 1 |
| 0x0C | 6×(2×I) | 6 组 `0xFFFFFFFF, 0x00000000` 哨兵值（分类计数） | — |
| 0x3C | 2×I | 保留，全 0 | — |
| 0x44 | m×I | 每个播放列表记录的绝对偏移 | 5044 |

> 社区参考实现只写 20 字节头。**本机实测为 72 字节**，说明代数间有差异。
> **对策：以设备现有文件为模板，仅改写计数与偏移。**

### 3.6 播放列表记录 `lphs`（44 + 4×songs）

| 偏移 | 类型 | 含义 | 本机值 |
| --- | --- | --- | --- |
| 0x00 | 4s | `lphs` | — |
| 0x04 | I | 长度 = 44 + 4×songs | 96 |
| 0x08 | I | 曲目数 | 13 |
| 0x0C | I | 非音频数 | 13 |
| 0x10 | 8s | dbid；**全 0 = 用内置 "All Songs" 语音** | 0 |
| 0x18 | I | 类型：**1=主列表(Master)**，2=普通 | 1 |
| 0x1C | 16s | 保留 | 0 |
| 0x2C | songs×I | **曲目索引（0 基），不是字节偏移** | 0,1,2…12 |

> ⚠️ 末尾是**索引**而非偏移，这与曲目头里的偏移表不同，容易搞混。

### 3.7 已验证：往返重建 100% 一致

用上述结构解析设备上的 `iTunesSD`，再用同样结构重新序列化：

```
original size: 5140   rebuilt size: 5140
>>> 完全一致（逐字节相同）
```

**这是本方案可行性的决定性证据** —— 意味着我们生成的数据库设备一定能读。

---

## 4. 架构决策：以 `Music/` 目录为唯一真相来源

**不做**增量二进制打补丁。改为：

```
iPod_Control/Music/**  ──扫描──>  曲目列表  ──读ID3──>  元数据
                                                    │
                                                    ▼
                                        重建整个 iTunesSD
```

- **新增歌曲**：把文件复制进 `Music/Fxx/` → 重建数据库
- **删除歌曲**：删掉文件 → 重建数据库
- **重建成本**：13 首约 1 毫秒，1000 首也是毫秒级

理由：

1. 与所有社区验证过的工具一致，行为可预期
2. 数据库永远由文件系统推导，不会出现「数据库说有一首歌但文件不在」的幽灵条目
3. 无需实现增量插入/重排偏移的全部边界逻辑，代码量小、出错面小
4. 天然幂等：用户用别的工具改过文件后，我们的软件自愈

代价：会丢失播放次数等统计（`iTunesStats` 独立文件，不受影响）、以及 Apple 为 `pregap/gapless` 计算的精确值（可接受，社区工具也这样）。

---

## 5. 技术栈

### 推荐：Electron + TypeScript（纯 Node，不引入 Python）

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 桌面外壳 | Electron | 与你 `appCheck` 同一套；`electron-builder` 出 NSIS 安装包，流程可复用 |
| 二进制读写 | Node `Buffer` | iTunesSD 的打包/解包手写即可，**零依赖** |
| 元数据解析 | `music-metadata` | 纯 JS，覆盖 MP3 / M4A / FLAC / WAV / OGG，能读标题/艺术家/专辑/时长/码率 |
| 设备识别 | `fs` 探测 A–Z 盘符找 `iPod_Control/iTunes/iTunesSD` | 避免原生模块，无需 node-gyp |
| VoiceOver TTS | 主进程调用 Windows SAPI 生成 WAV | 用 **PowerShell 绝对路径**，规避 nvm4w 的 System32 缺失问题 |
| 界面 | HTML + CSS（手写主题变量） | 你的审美可以 1:1 落地 |
| 通信 | `contextBridge` + `ipcRenderer.invoke` | 渲染层不直接碰文件系统 |

**推荐理由**：这个软件真正的差异化在界面质量（拖拽、列表、容量条），HTML/CSS 是最能还原你「清新简约 + 轻量科技感」的载体；而你已有 Electron 打包经验，产出一个 `.exe` 的路径最短。两个技术难点（二进制写入、标签解析）在 Node 生态里都有成熟解法。

### 备选方案

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| **Python + PySide6(Qt)** | `mutagen` 是标签解析标杆；社区参考实现就是 Python，可直接移植，技术风险最低 | Qt 自定义样式工作量更大；PyInstaller 打包体验不如 electron-builder |
| **Python 内核 + 本地网页界面** | 开发最快，界面同样自由 | 需要额外做启动器；严格说不是一个"软件" |

---

## 6. 分阶段实施

### 阶段 0 —— 可行性验证 ✅ 已完成

- [x] 解析设备上 Apple 生成的真实 `iTunesSD`
- [x] 验证 VoiceOver 文件名规则（对照备份数据逐字符命中）
- [x] 往返重建逐字节一致
- [x] **备份设备现有数据库到本地**（`backups/`）
- [x] 用「改曲目数 + 重建」做写入验证，实机确认设备读到 3 首 ✅
- [x] 定位 VoiceOver 总开关（根头 29 字节）与语音文件命名规则
- [x] 打通中文 TTS 生成（Windows SAPI，离线）

### 阶段 1 —— 核心引擎（无界面）

- [ ] 设备发现：扫描盘符，校验 `iPod_Control/iTunes/iTunesSD` 存在
- [ ] `itunessd` 模块：`parse(file)` / `build(model)`，含模板继承
- [ ] `metadata` 模块：读 MP3/M4A 标签 + 时长 + 采样率
- [ ] `library` 模块：扫描 `Music/**`，组装曲目列表
- [ ] `voiceover` 模块：dbid 派生 + WAV 生成 + 格式对齐 + 幂等复用
- [ ] 增删：复制/删除文件 + 重建数据库 + 同步语音
- [ ] 安全：写前自动备份、临时文件原子替换、写入后强制 flush
- [ ] 单元测试：以备份的真实 `iTunesSD` 为 fixture 做回归

### 阶段 2 —— 界面

- [ ] 左右双栏：本地音乐库 ↔ iPod 曲目列表
- [ ] 拖拽导入、勾选删除、批量操作
- [ ] 列表列：标题 / 艺术家 / 专辑 / 时长 / 格式 / 大小
- [ ] 搜索、排序、按「标题+艺术家+时长」判重
- [ ] 顶部容量条：已用/剩余，导入前预检空间
- [ ] **VoiceOver 开关**：勾选后为曲目生成中文语音播报，写入设备
- [ ] 底栏「写入 iPod」+ 进度反馈，结束后提示安全弹出

### 阶段 3 —— 增强

- [ ] 播放列表：导入 M3U/PLS，或按文件夹 / ID3 模板自动生成（含 `Speakable/Playlists/`）
- [ ] 音量增益（0–99）、码率/采样率预检、超容量提示
- [ ] 语音风格选项：语速、可选语音音色、播报模板（仅曲名 / 曲名+艺术家）

---

## 7. 风险与对策

| # | 风险 | 影响 | 对策 |
| --- | --- | --- | --- |
| 1 | **FAT32 写缓存**：文件写完后仍在系统缓存里，未落盘就拔线，iPod 看到旧数据库 | 高 | 写入后 `fsync` + 双次 flush；UI 强提示"安全弹出后再断开"；未安全弹出时给出显式警告 |
| 2 | 误删设备私有文件 | 高 | 只允许操作 `Music/` 下的音频；`Device/`、`Speakable/System`、`Speakable/Messages`、`Speakable/VoiceOverDB` 设为只读白名单 |
| 3 | 代数差异（`0x02010001` vs `0x02000003`、`hphs` 72B vs 20B） | 中 | **不硬编码任何版本常量**，读取设备现有文件作模板继承 |
| 4 | `pregap/gapless/numsamples` 等字段含义未完全确定 | 中 | 新记录从设备现有记录复制模板，只覆盖路径/时长/格式/dbid；实机播放验证 |
| 5 | 文件名字段是 UTF-8 且限 256 字节 | 中 | 超长截断、非法字符过滤、非 ASCII 路径实测 |
| 6 | nvm4w 环境导致子进程 PATH 缺 System32 | 中 | 所有 `spawn` 用绝对路径；TTS 走固定绝对路径的 powershell |
| 7 | 高码率 / 非 MP3 格式不被支持 | 低 | 导入前预检格式与码率并提示；可选接 ffmpeg 转码 |
| 8 | 用户用 iTunes 再次同步会覆盖我们的数据库 | 低 | UI 说明"本工具与 iTunes 二选一"；提供一键备份/还原 |

---

## 8. 建议目录结构

```
ipodTools/
├── package.json
├── electron-builder.yml
├── src/
│   ├── main/
│   │   ├── index.ts              主进程入口 / IPC 路由
│   │   ├── ipod/
│   │   │   ├── discover.ts       盘符扫描与设备识别
│   │   │   └── paths.ts          iPod 路径常量与安全校验
│   │   ├── itunessd/
│   │   │   ├── model.ts          数据结构定义
│   │   │   ├── parse.ts          二进制 → 模型
│   │   │   ├── build.ts          模型 → 二进制
│   │   │   └── template.ts       从设备现有文件继承头部模板
│   │   ├── metadata/tags.ts      ID3 / MP4 标签解析
│   │   ├── library/
│   │   │   ├── scan.ts           扫描 Music 目录
│   │   │   ├── add.ts            导入
│   │   │   └── remove.ts         删除
│   │   ├── voiceover/tts.ts      Windows SAPI 语音生成
│   │   └── safety/backup.ts      备份 / 原子写入 / flush
│   ├── preload/index.ts
│   └── renderer/                 界面
└── tests/
    └── fixtures/iTunesSD         设备真实备份，用于回归比对
```

---

## 10. 验证阶段的补充发现（2026-09-15 更新）

### 已确认的决策
- 设备代数：**第 4 代**（机身带按键）
- 技术栈：**Electron + TypeScript**
- VoiceOver：**需要**，含中文 TTS 生成（已实机验证机制，见 2.4 与第 11 节）

### 设备的实际内容
13 首全部是**大学英语六级听力材料**（模拟试题 1–3 + 2009–2013 历年真题），
时长 30–35 分钟，其中 3 首是 22050 Hz / 40–64 kbps 低码率，其余 44100 Hz / 128 kbps。

### 关键发现：音频文件几乎没有 ID3 标签

| 文件 | ID3v2 | mutagen 能否解析 |
| --- | --- | --- |
| SBJT / DQNL / OOFR / IEWX | **无**（直接以 MPEG 帧同步开头） | 否 |
| 其余 9 首 | 4096 B（但无标题字段） | 是 |

**真实曲名只存在于 `iTunesDB`。** 已实测解析出全部标题：

| # | 文件 | 标题 | 时长 |
| --- | --- | --- | --- |
| 0 | F00/SBJT.mp3 | 六级模拟试题 1 | 24:57 |
| 1 | F00/DQNL.mp3 | 六级模拟试题 2 | 26:28 |
| 2 | F00/OOFR.mp3 | 六级模拟试题 3 | 26:44 |
| 3 | F00/VQCA.mp3 | 2009年06月六级听力真题 | 34:42 |
| 4 | F02/DQMD.mp3 | 2009年12月六级听力真题 | 32:06 |
| 5 | F01/NEPE.mp3 | 2010年06月六级听力真题 | 33:09 |
| 6 | F00/YTKZ.mp3 | 2010年12月六级听力真题 | 34:30 |
| 7 | F01/WBSM.mp3 | 2011年06月六级听力真题 | 31:16 |
| 8 | F01/AWWS.mp3 | 2011年12月六级听力真题 | 30:51 |
| 9 | F02/CGMU.mp3 | 2012年06月六级听力真题 | 32:14 |
| 10 | F00/INUQ.mp3 | 2012年12月六级听力真题 | 30:17 |
| 11 | F01/GAKR.mp3 | 2013年06月六级听力真题 | 30:04 |
| 12 | F01/IEWX.mp3 | 2013年12月六级听力真题 | 30:31 |

**→ 架构影响：元数据必须双来源。** 优先级为
`ID3/MP4 标签` → `iTunesDB 标题` → `文件名`。
否则这 13 个文件在界面上只会显示 `SBJT`、`DQNL` 这样的 4 字符乱码。

`iTunesDB` 的 mhod 结构（已实测确认）：
偏移 `0x0C` = 类型（1=标题、2=路径、3=专辑、4=艺术家、6=格式描述）；
字符串长度在 `header_length+4`，字符串数据在 `header_length+16`（UTF-16LE）；
**路径使用 `:` 分隔**（如 `:iPod_Control:Music:F00:SBJT.mp3`），与 iTunesSD 的 `/` 不同。

### 曲目记录字段规律（13 首样本分析，已实测）

| 字段 | 规律 | 新增曲目时 |
| --- | --- | --- |
| `0x120` | **13 首全部 = 528** → 编码器起始延迟，常量 | 直接填 528 |
| `0x124` | 每首不同（530–3968）→ 尾部 padding | 先填 0，实机验证 |
| `0x128` | = 时长(ms) × 采样率 ÷ 1000 − 0x120 − 0x124 | 按公式计算 |
| `0x130` | ≈ 文件字节 − ID3 标签（比文件小 0.01–0.05%） | 按公式估算 |

### 混合策略（据此确定的最终写入策略）

重建数据库时**按路径匹配**：设备上原已有的文件**沿用其原始记录**（保留 Apple 计算的
精确字段），只有真正新增的文件才由我们生成记录。这样存量内容零风险，新增内容风险隔离。

### 实机验证（阶段 0 收尾）

参考实现已落地为 `tools/itunessd-reference.py`，三个命令：

| 命令 | 作用 |
| --- | --- |
| `probe` | 只读列出设备曲目（含从 iTunesDB 还原的标题） |
| `validate` | 重建为 3 首的数据库并写入设备（验证写入通路） |
| `restore` | 从最近一次备份还原 |

已验证：`build(parse(x)) == x` 逐字节成立（设备原文件 5140 B）。

验证用的 3 首数据库（写入后）：

| # | 文件 | 时长 | 记录来源 |
| --- | --- | --- | --- |
| 0 | F00/VQCA.mp3 | 2082.4s | **全新生成**（新 dbid、手工计算各字段） |
| 1 | F00/SBJT.mp3 | 1496.8s | 沿用原记录 |
| 2 | F02/CGMU.mp3 | 1934.1s | 沿用原记录 |

备份位置：`backups/20260915-111953/`（原始状态）、`backups/20260915-112331-prechange/`（改动前）。

### 实机验证结果（用户上机确认，2026-09-15）

- 只能循环听到 **3 首**（原为 13 首）→ **写入通路打通，设备确实读我们重建的 `iTunesSD`** ✅
- 按 VoiceOver 按钮：第 0 首（全新记录）静音，第 1、2 首（原记录）正常播报
  → 与预期完全一致：全新记录的 dbid 没有对应语音文件，所以静音。
  **这不是故障，是"缺语音文件"这一个独立问题**，第 11 节解决。

---

## 11. VoiceOver 实现方案（2026-09-15 追加）

### 11.1 结论

VoiceOver 已从"可选的阶段 3"提升为**阶段 1 核心模块**。机制已完全掌握，
且**全部可离线完成**（Windows 内置中文语音，无需联网、无需第三方 TTS）。

### 11.2 数据流

```
曲目标题（ID3 → iTunesDB → 文件名）
        │
        ├─ dbid = md5(文本 UTF-8)[:8]        ← 8 字节
        │      │
        │      └─ 文件名 = 倒序十六进制大写
        │                  →  iPod_Control/Speakable/Tracks/XXXXXXXX.wav
        │
        └─ 播报文本 → SAPI 合成 WAV → 重打包为 Apple 容器 → 写入上面的路径
```

### 11.3 WAV 容器格式（已实机逐字节确认）

设备上 13 个 Apple 语音文件的容器**完全一致**，结构如下：

| 偏移 | 长度 | 内容 |
| --- | --- | --- |
| `0x0000` | 4 | `"RIFF"` |
| `0x0004` | 4 | `riff_size` = 文件总长 − 8 |
| `0x0008` | 4 | `"WAVE"` |
| `0x000C` | 4 | `"fmt "` |
| `0x0010` | 4 | `16` |
| `0x0014` | 16 | PCM 描述：`01 00`(PCM) `01 00`(单声道) 采样率 `22 56 00 00`(22050) 字节率 `44 ac 00 00`(44100) 块对齐 `02 00` 位深 `10 00`(16) |
| `0x0024` | 4 | `"FLLR"` |
| `0x0028` | 4 | `4044` |
| `0x002C` | 4044 | **全零填充** |
| `0x0FF8` | 4 | `"data"` |
| `0x0FFC` | 4 | PCM 数据长度 |
| `0x1000` | … | PCM 数据 |

**头部固定 4096 字节**（4 KB 对齐，利于闪存），格式 `22050 Hz / 16 bit / 单声道 PCM`。

**这是关键差异点**：Windows SAPI 直接输出的是 46 字节紧凑头、`fmt ` 块为 18 字节。
本模块**统一重打包为上面的 Apple 容器**——实测头部 4096 字节与 Apple 文件
**逐字节一致**（仅两个长度字段因音频长度不同而合理不同）。
这样就不存在任何格式兼容性猜测了。

### 11.4 已落地的参考实现

`tools/voiceover.py`

| 能力 | 说明 |
| --- | --- |
| `voice_filename(dbid)` | dbid → VoiceOver 文件名（13/13 实机验证） |
| `dbid_from_text(text)` | 文本 → dbid，保证幂等复用 |
| `unique_dbids(texts)` | 批内去重，同曲名不同文件各得独立 dbid |
| `build_apple_wav(pcm, ...)` | 按上表构造 4096 字节头的 Apple 容器 |
| `repack_to_apple(src, dst)` | 任意 PCM WAV → Apple 容器 |
| `parse_wav(path)` | 稳健的 RIFF 块解析（兼容 4096 字节头） |
| `SapiTts.synth(...)` | Windows SAPI5 合成，默认重打包为 Apple 容器 |
| `SapiTts.pick_voice()` | 自动优选中文语音（本机 = `Microsoft Huihui Desktop`） |

CLI：`voices` / `say`（`--raw` 保留原始紧凑头）/ `inspect` / `name`

`tools/itunessd-reference.py` 新增命令：

| 命令 | 作用 |
| --- | --- |
| `speakable` | 只读盘点：语音目录、现有文件格式、逐曲匹配情况 |
| `voiceover` | 补齐缺失语音；`--force` 重生成、`--dry-run` 预演、`--track N` 单曲 |

**格式对齐**：`voiceover` 默认读取设备上 Apple 现有语音文件的采样率并对齐
（`--rate` 可覆盖），再按 Apple 容器重打包。无需手动指定任何格式参数。

### 11.5 TS 版落地方式（阶段 1）

- dbid / 文件名 / 4096 字节容器：纯 Buffer 运算，直接移植，零依赖
- TTS：`child_process.spawn` 调用**绝对路径**的
  `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`，
  用 `System.Speech.Synthesis.SpeechSynthesizer` + `SetOutputToWaveFile`
  （规避 nvm4w 丢 System32 的已知问题，见风险 6），
  再把输出重打包为 Apple 容器
- 幂等：写入前检查文件是否存在，存在即跳过，避免重复合成
- **存量曲目零成本**：重建时沿用 Apple 原 dbid → 原语音文件继续有效，
  完全不需要重新合成。只有真正新增的曲目才需要生成语音
- 容量：每首语音约 90–170 KB（2–4 秒 @ 22050 Hz 单声道 16 位），
  100 首约 15 MB，相对 1.87 GB 可忽略；但仍计入容量预检

### 11.6 风险更新

| # | 风险 | 影响 | 对策 |
| --- | --- | --- | --- |
| 9 | ~~语音 WAV 格式与设备要求不符~~ | ~~中~~ | ✅ **已消除**：容器与 Apple 逐字节一致，格式 22050/16/单声道 |
| 10 | 中文语音在设备上读不出 | 低 | 设备已有 `zh-CN.plist` + `VoiceOverDB`（Nuance Mei-Ling）；逐曲语音是独立音频文件，与系统语言包无关 |
| 11 | 大量曲目 TTS 合成耗时 | 低 | 幂等跳过 + 后台并行合成 + 进度条；实测单曲 < 0.5 秒 |
| 12 | 同曲名两首歌 md5 撞车 → 共用语音文件 | 低 | `unique_dbids()` 批内检测冲突并追加序号后缀 |

---

## 12. 工程实现完成情况（阶段 1，已实机验证）

### 12.1 代码结构

```
src/main/index.ts            主进程 + IPC 路由
src/preload/index.ts         contextBridge 暴露的 window.ipod API
src/renderer/                界面（index.html / styles.css / app.js）
src/main/core/
  types.ts        全部接口定义
  itunessd.ts     parseSd / buildSd / makeTrackRecord / withTracks
  itunesdb.ts     只读解析 iTunesDB（取标题/艺术家）
  audio.ts        MP3 帧遍历 + M4A + readTags + 时长
  fsx.ts          atomicWrite / flushFile / flushVolume / backup / 受控删除
  voiceover.ts    dbid、文件名、WAV 解析、Apple 容器、双后端 TTS
  device.ts       设备发现 + loadLibrary（三级标题回退）
  library.ts      本地文件扫描与预检
  sync.ts         syncDevice 主流程
scripts/
  test-core.js        单元/集成回归（59 项）
  e2e-device.js       真机端到端（41 项）
  restore-library.js  从备份恢复设备曲库
  clean-device.js     清理孤儿文件
```

npm 脚本：`build` / `start` / `dev` / `test:core` / `test:device` /
`device:clean` / `device:restore` / `package` / `package:dir`

### 12.2 回归测试

`npm run test:core` —— 组别：T1 往返字节一致 / T2 语音命名 / T3 Apple 容器 /
T4 MP3 元数据对齐 Apple 记录值 / T5 iTunesDB / T6 端到端同步 /
T7 语音全链路 + 幂等 / **T8 一致性收敛** / T9 VoiceOver 合成 / **T10 热插拔去抖**。

T8 / T9 / T10 都不需要真机。未接设备时 T4–T7 自动跳过，其余照常全跑。

> **写测试的硬规矩：素材必须取自"设备当前实际内容"，不得钉死在特定曲目上。**
> 2026-09-15 踩过一次：T4 用一张写死了 13 首原始曲目数字的表，T6 用归档数据库的
> 前 3 首当种子、再从真机复制对应文件 —— 而那几首正是本工具被拿来删掉的对象。
> 用户一删，`test:core` 就莫名为"文件不存在"而崩，`checked > 0` 这类断言也跟着挂。
> 现在 T4 对表里没有的文件回落到**设备数据库自己记录的数值**（同样出自 Apple，
> 只是不再依赖那 13 首还在），T6 从设备当前曲库里取种子并留至少 1 个文件当新增源。
> 同理，采样率也不能写死：实测素材里 44.1kHz / 22.05kHz / 48kHz 都有。

### 12.3 真机端到端（X317，F:）

`npm run test:device` → **通过 41 · 失败 0**

走的是 GUI「同步」按钮背后的同一个 `syncDevice()`，完整跑
「导入 → 生成中文语音 → 删除 → 回到原状」：

```
+2.4s  Music 13->14  新增 F02/MFXW.mp3          ← 导入
+7.3s  Tracks 13->14 新增 9C...E54.wav.tmp      ← 原子写临时文件
+7.7s  Tracks 14->14 新增 9C...E54.wav 消失 .tmp ← 原子替换
+8.1s  Music 14->13  消失 F02/MFXW.mp3           ← 删除
+8.9s  Tracks 14->13 消失 9C...E54.wav           ← 语音一并清理
```

验收要点：
- 新曲目的音频字节数与本地源文件完全一致，时长与数据库记录一致（±2ms）
- 新记录 `pregap=528`、`filetype=1`、`albumid` 沿用存量曲目
- 新语音是 **Apple 4096 字节容器**，`data` 块精确落在 0x1000，22050Hz/单声道/16bit
- 存量 13 个语音文件**一个都没被改写**（沿用原 dbid 的设计生效）
- 收尾后 `iTunesSD` 与 Apple 原始文件**逐字节一致**，孤儿文件 0

### 12.4 环境发现：本机 PowerShell 被策略拦截

`powershell.exe` 在本机进程树中启动即报 `WinError 5`（从 Python 侧同样
`PermissionError`），属策略拦截，非代码问题。
`voiceover.ts` 因此做**双后端**：PowerShell(System.Speech) 优先 →
**Python + pywin32 SAPI5** 兜底，并可用 `IPODTOOLS_TTS` 环境变量强制。
两条通道产物一致（同 4096 字节容器、同文件名、同 22050Hz 格式），无功能损失。
界面诊断栏会显示当前实际后端。

另外 `childEnv()` 会剥离 `NODE_OPTIONS` —— 本机被注入过
`node-language-shim.cjs`，会污染派生子进程。

### 12.5 施工注意

- **`Music/` 是唯一真相来源**；`iTunesDB` 只读不写，`Device/`、
  `Speakable/System`、`Speakable/Messages` 永不触碰
- 每次写 `iTunesSD` 前自动备份到 `backups/<时间戳>-prechange/`
- 真机测试脚本带**严格基线断言**：设备不干净（有孤儿文件/语音）就直接退出，
  拒绝在脏基线上做差异比对 —— 否则失败信息全是噪声
- 断开前必须「安全弹出」；FAT32 写缓存会吞掉数据库

## 13. 一致性不变式（2026-09-15 追加）

**同步结束后：数据库登记集合 ≡ `Music/` 下真实存在的文件集合。**

两个方向都要收敛，只做一边就会留垃圾：

| 不一致 | 处理 | 字段 | 不处理的后果 |
|---|---|---|---|
| 有记录、没文件 | 清除记录 | `ghostPruned` | 设备上出现点不响的幽灵曲目 |
| 有文件、没记录 | 删除文件 | `orphanRemoved` | 白占空间，且设备本来就播不到 |
| 语音文件无对应曲目 | 删除语音 | `orphanVoiceRemoved` | 同上 |

### 13.1 用户偏好：不做音频备份，改为保证一致性

明确放弃"删除前把音频/语音复制到备份目录"的方案。理由：事后补救不如事前保证，
备份只会越堆越大，还会给人"删错了也能救回来"的错觉。
**数据库备份保留**（`backups/*-prechange/iTunesSD`，约 5 KB）——它保住的是
dbid，dbid 一变全部语音文件名失效、整机播报哑掉，这是备份真正不可替代的价值。

### 13.2 「删文件」是不可逆操作，撤销掉三道闸

`pruneOrphans` 默认开启，但必须先过安全检查，否则宁可留下垃圾：

1. **完整数据库可往返** —— `buildSd(parseSd(raw)).equals(raw)` 必须成立。
   还原不出来说明我们的解析对这份数据库不完整（例如没见过的版本），
   此时「哪些文件没被引用」这个判断本身就不可信 → 整体放弃清理。
2. **数据库非空** —— `tracks.length > 0`。防止把整个 `Music/` 当孤儿清空。
3. **写入成功后才删** —— 清理排在数据库原子写 + 回读校验之后。写入失败会先抛错，
   孤儿文件留到下次再清，不会出现「文件删了、库里还留着记录」这种更糟的中间态。

`pruneOrphans: false` 可完全关闭。UI 侧对应「纯清理也要先弹确认框」。

### 13.3 回归覆盖

`npm run test:core` 的 **T8（19 项）** 专测这个不变式，**不需要真机**：
借 Apple 原始数据库的前 3 条真实记录当模板，音频换成合成 MPEG 帧
（`FFFB9000` = MPEG1/LayerIII/128kbps/44.1kHz，帧长恒为 417 字节）。
覆盖：删文件→记录收敛、孤儿音频→删除、无主语音→删除、
存活语音保留、数据库可往返、数据库为空→放弃清理、`pruneOrphans=false`→纹丝不动。

`npm run test:ui` 的**界面自检 42 项**覆盖删除与清理两道确认门（含取消不写入）、
「写入」与「移除」两个按钮的参数隔离、待导入列表的移除按钮（只删对应那一行、
删完立即重绘），以及**设备热插拔的界面收敛**（见 §16.7）。
注意该脚本不挂 preload，跑的是预览演示数据 —— 报告会显式标注「数据源」，
其中的「设备栏」不代表真机状态。**它覆盖不到「渲染进程 → preload → IPC」这条链**；
需要验那条链时用 `electron-e2e-probe` skill 的手法。

---

## 14. VoiceOver 试听（2026-09-15 追加，同日移除）

> **该功能已删除。** 本节保留为记录：说明它曾存在、删掉了哪些代码、以及从中得到
> 的两条通用经验 —— 避免以后重复踩坑，或被重新"发明"一遍。

### 14.1 现状

用户 2026-09-15 要求移除「试听语音播报」入口，相关代码已全部删除（清单见 14.2）。

**语音合成本身不受影响。** VoiceOver 仍然会生成，路径不变：`sync.ts` 在写入设备时
对每首曲目调用 `announceText(title, artist)` 得到播报文本，经 `synthesize()` 合成、
包成 Apple 4096 字节容器，落到 `Speakable/Tracks/`。这条路径由 `T9` 守着（见 14.3）。

### 14.2 删除清单

| 层 | 删除内容 |
|---|---|
| core | `voiceover.ts` 的 `toCompactWav()`（Apple 4096B 容器 → 标准 44B WAV）、`activeBackendName()` |
| main | `index.ts` 的 `voiceover:preview` IPC、`previewVoiceover()`、24 条 LRU 预览缓存 |
| preload | `previewVoiceover()` 的接口声明与实现 |
| renderer | `app.js` 的 `audition()` / `stopAudition()` / `speakerButton()` / `SPEAKER_ICON`，两块列表里的喇叭按钮，`createPreviewApi` 的预览桩 |
| css | `.icon-btn.speaker`（含 `:hover` / `.loading` / `.playing`）与 `vo-pulse` 动画 |
| html | CSP 去掉 `media-src 'self' data:` —— 渲染进程已不再播放任何音频 |
| test | 删除 `scripts/verify-audition.js` 与 `npm run test:audition`；`verify-ui.js` 去掉 6 条试听断言、补 1 条列表重绘断言（36 → 31 项）；`test-core.js` 的 T9 去掉 `toCompactWav` 段（19 → 9 项） |

`toCompactWav()` 是唯一被整体删掉的 core 函数 —— 它只服务于"把 Apple 容器变成
浏览器能播的容器"这一件事，没有其他调用方。`parseWav()` / `buildAppleWav()` /
`repackToApple()` 都是写入路径要用的，全部保留。

### 14.3 保留下来的 T9（`npm run test:core`）

T9 由「试听音频通路」改名为 **VoiceOver 合成（Apple 容器）**，只断言**要写进设备
的那份数据**：`announceText` 的拼装规则（等于标题本身 / `标题 - 艺术家` 以 " - "
连接 / 艺术家为空白时不留下多余连字符）、合成产物是 4096 字节头的 Apple 容器、
含 `FLLR` 填充块、22050Hz 单声道 16bit PCM、时长 > 0、同一文本重复合成 PCM 长度稳定。
**不依赖真机。**

### 14.4 两条留下来的经验（与功能无关，仍然有效）

**1）浏览器策略是"读代码看不见"的一类 bug。**
试听当年踩的坑：CSP 只写 `default-src 'self'` 而没配 `media-src`，
`<audio src="data:...">` 会被**静默拦掉**，表现为"点了一点声音都没有"。
`preload → IPC → TTS → 容器转换` 每一段单独看都正确，问题出在最后一步的浏览器策略上。
该手法已沉淀为 `electron-e2e-probe` skill：需要验证"渲染进程 → preload → IPC →
主进程"整条链、或验证某个浏览器策略是否把功能拦掉时，照它做。

**2）播报文本只有一个来源。**
任何"预览 / 试听 / 展示"层都**不得另拼一份字符串**，必须调 `announceText()`，
否则展示出来的和真正写进设备的会不一致 —— 那比没有预览更糟。
这条约束在试听删掉之后依然成立：界面上的曲名与设备实际念出来的，本来就是两回事。

## 15. 写入与移除拆成两个按钮（2026-09-15 追加）

### 15.1 问题

原来底栏只有一个「写入 iPod」，它同时承担**新增**和**移除**两件事。于是出现这种
容易踩的误读：把设备上的曲目勾上（= 标记移除）之后，视线落到那个蓝色主按钮上写着
「写入 iPod」—— 很自然会以为"点它就是确认刚才的删除"，但它其实是"把左边待导入的
歌写进去"。两件事共用一个按钮 + 一个动词，语义就糊了。

### 15.2 拆法：按钮各管一件事，**在参数层面隔离**

```
[安全弹出]  [移除 N 首]  [写入 iPod（N 首）]
             ↑ 危险色      ↑ 主色
```

| | 「写入 iPod」 | 「移除 N 首 / 清理设备」 |
|---|---|---|
| `addSources` | 待导入列表 | **恒为 `[]`** |
| `removeIds` | **恒为 `[]`** | 勾选的曲目 |
| `pruneOrphans` | **恒为 `false`** | `true` |
| 二次确认 | 不需要（只增不减，非破坏性） | 必须（列出曲名 / 清理项） |
| 完成后清掉 | 左侧待导入列表 | 勾选集合 |

一致性清理（清失效记录、删未登记文件）归到**移除**按钮：它本质是"从设备上拿掉
东西"，和写入的"只增不减"是相反方向。

分成两个入口的附带好处：做完一件事只消化对应那笔待办。写完歌，你好不容易勾好的
待删列表还在；删完歌，左侧待导入列表也不受影响。

### 15.3 连带修掉的一个真 bug

`loadDevice()` 里原本无条件 `state.marked.clear()`。这在单按钮时代无感，拆开之后
立刻暴露成 bug：**点一次「写入」，刚勾好的待移除曲目全被抹掉**（实测：写入前勾选
3 首，写入后变 0）。

改为按"曲目是否还存在"核对，而不是一律清空：

```js
const alive = new Set(state.tracks.map((t) => t.id));
state.marked = new Set([...state.marked].filter((id) => alive.has(id)));
```

一份代码同时满足两边：移除流程里被删的曲目已不在列表 → 勾选自然落空（等价于清空）；
写入流程里曲目没动 → 勾选原样保留。

### 15.4 回归覆盖（`npm run test:ui`，36 项，本次新增 11 项）

断言的是**真正发给主进程的参数**，不是按钮上印的字 —— 光看文案说明不了隔离是否成立。
`window.__ipodUi` 因此额外暴露了 `api`，让自检可以把 `api.runSync` 换成拦截器：

- 点「写入 iPod」不弹确认框；只提交新增；**`removeIds === []` 且 `pruneOrphans === false`**
- 写入后勾选的待移除原样保留、待导入列表被清空
- 点「移除」必弹确认；**`addSources === []`**；`pruneOrphans === true`
- 移除后待导入列表原样保留

### 15.5 界面上的辅助线索

- 右侧面板标题旁常驻小字 `勾选 = 标记移除`（左右两个列表外观相近，不写会混）
- 每行复选框 `title="勾选 = 从设备移除这一首"`
- 状态栏分两笔报账：`待写入 2 首 · 已标记移除 2 首。`，不再合成一句"待写入"


## 16. 设备热插拔检测（2026-09-15 追加）

### 16.1 问题

原来只有两个时机会去检测设备：**启动时**、以及用户点「重新检测 / 刷新」。
于是拔掉 iPod 后界面毫无反应 —— 设备卡、曲目列表、容量条全都停在旧数据上，
看着就像设备还插着。用户会以为"是不是没拔干净"，或者对着一个不存在的设备点写入。

### 16.2 方案：轮询一个极便宜的探针，而不是监听系统设备事件

Windows 有 `WM_DEVICECHANGE`，但落到 Node/Electron 里只有两条路，都不划算：

| 方案 | 代价 |
|---|---|
| 原生插件（`usb-detection` / `node-wmi` / `drivelist` 事件） | 需要 node-gyp 针对 **Electron 的 ABI** 重新编译（本机 nvm4w + 企业策略，风险高）；给打包引入原生依赖，而我们连 NSIS 都还没打通 |
| 常驻一个 PowerShell/WMI 订阅进程 | 给安装包再添一个可执行文件；进程生命周期、僵尸进程都要自己管 |

而**探针本身便宜到可以忽略**。实测 `findIpodRoots()`（对 A:–Z: 做 26 次
`existsSync`，不启动任何子进程）：

```
单次探测平均：0.529 ms
每秒一次 → 一天累计 CPU 时间 45.7 秒（约 0.05%）
```

所以选**每秒轮询**。真正昂贵的操作（`volumeLabel()` 要起 PowerShell、
`loadLibrary()` 要读全部文件）只在状态**真的变化**时各跑一次。

### 16.3 去抖：连续 2 次观测才认账

单次 `existsSync` 失败**不能**当作"拔出了"：设备刚挂载、正在刷盘、或恰好在写
文件的那一瞬间都可能读不到，一次误判就会让界面闪一下"设备已断开"再跳回来，
比不检测更烦人。

因此要求同一状态被**连续观测 2 次**（约 2 秒）才认账。代价是插拔后最多约 2 秒
延迟，换来的是不误报。这段判定抽在 `core/hotplug.ts` 的 `StableDetector` 里 ——
**单独成模块就是为了能测**：`main/index.ts` 的定时器需要拉起 Electron 才能跑，
而抽出来之后 `test:core` 的 T10 可以用任意观测序列直接喂它，不需要真机、
也不需要真的等秒数。

T10 覆盖：单次不认账、连续两次确认、抖动后计数清零、候选被打断需重新累计、
以实际状态为初值（启动时不误报插入）、`confirmTicks=1`、下限夹到 1。

### 16.4 数据流

```
main/index.ts  setInterval 1000ms
  └─ findIpodRoots() → StableDetector.observe()
       └─ 确认变化 → webContents.send('device:changed', { root })
            └─ preload onDeviceChange(root)        （拔掉时 root 为 null）
                 └─ 渲染层 onDeviceChanged(root)
```

### 16.5 渲染层怎么响应

**插入** → 自动选中并读取曲库（状态栏给出"已读取设备曲库：N 首"）。

**拔出** → `handleDeviceGone()` 一次清干净：

- `root` / `device` / `tracks` 全部清空，设备栏回落为「未检测到设备」
- **作废针对该设备的待移除标记** —— 设备都不在了，这些标记既写不进设备也没法
  核对，留着只会在下次接入时变成一颗定时炸弹。作废数量会写在状态栏里
- 设备相关按钮（安全弹出 / 移除 / 写入）全部禁用
- **左侧「本地音乐」列表不动**：它属于本机，与设备无关

「安全弹出」是个特例：弹出后设备卸载，探测随即报"断开"。若不处理，用户刚看到
"可以拔线了"就立刻被"iPod 已断开"顶掉。所以 `doEject()` 成功后置
`state.ejected = true`，断开通知据此改用"已安全弹出，现在可以拔线了。"。
同时**删掉了 `doEject` 里原来的延时 `refreshDevices()`** —— 它现在多余，而且会
立刻用"未检测到 iPod"（红色）盖掉那句提示。

正在写入/移除时（`state.busy`）收到插拔通知直接忽略：设备中途被拔，写入流程自己
会失败并报错，探测再插一脚只会把错误信息冲掉。

### 16.6 顺手修掉的一个潜伏 bug

`loadDevice()` 里原本是 `state.device = d || null`，紧接着无条件写
`state.device.__missing = …`。设备已拔出时 `d` 为 `null`，于是抛
`TypeError: Cannot set properties of null` —— 被 catch 成一句看不懂的
"读取设备失败"，而**界面上的旧设备信息还留着**。这正是用户报的现象的另一半原因。
现在改为：找不到设备就直接走 `handleDeviceGone()` 并提示断开。

### 16.7 验证

**`npm run test:ui`（42 项）** —— 新增 10 条热插拔断言，直接调渲染层的
`onDeviceChanged`（等价于收到 IPC），不需要真机。含一条对照用例（断开前按钮可用），
避免用例本身失效却"通过"。

**`npm run test:hotplug`（14 项，需要真机在场）** —— 补上 `test:ui` 覆盖不到的那一段：
`webContents.send → ipcRenderer.on → 回调`。脚本自己就运行在主进程里，于是可以
**扮演事件源**直接推 `device:changed`，走完整条真实链路，**不需要真的拔插设备**。
断言含：preload 确实暴露了接口、拔出后状态清零/按钮禁用/文案正确、
推回插入后**真的重新读回曲库**（曲目数与初始一致）。

> 为什么不塞进 `test:all`：它需要真机在场（没设备时退出码 2 表示跳过），
> 和 `test:device` 一样单独一个脚本。

> **踩坑记录**：首次运行 `test:ui` 的"拔出后状态栏提示断开"失败，拿到的文案是
> "已安全弹出…"。根因是前面的用例点过结果弹层的确认按钮，而那个按钮的回调就是
> `doEject()`，把 `state.ejected` 留成了 `true`。探针必须显式把现场重置干净。

---

## 17. 新增曲目没有 VoiceOver —— 后端探测过窄 + 测试静默跳过

### 17.1 现象

用户导入新歌后，设备上播放新歌**不播报歌名**（老歌正常）。
设备实况：`ONOI.mp3`「小镇姑娘」、`KMCY.mp3`「山雀」都有语音，
新加的 `LLOI.mp3`「庐州月」`hasVoiceover = false`。

### 17.2 根因（三层，缺一层都不会造成这个结果）

1. **TTS 后端不可用。** 本机 PowerShell 被安全策略拦截（`EACCES` / WinError 5），
   `resolveBackend()` 退到 Python + pywin32；而机器上**所有常规 Python 都没装
   pywin32**（Python311 / miniconda / WorkBuddy 的 3.13 全部 `ModuleNotFoundError`）。
   唯一装了 pywin32 的解释器位于 WorkBuddy 自带的隔离 venv，而旧的
   `pythonCandidates()` 只扫 PATH 和 `LOCALAPPDATA\Programs\Python\Python311`
   —— **扫不到它**，于是 `backend = null`。
2. **失败被静默吞掉。** `synthesize()` 抛错 → `sync.ts` 第 7 步 catch 后只 push 进
   `warnings`，同步照常算"成功"。界面 `loadTtsDiagnostics()` 启动时确实会把
   「生成中文 VoiceOver」**自动取消勾选并禁用**、并把 tag 写成"语音后端不可用"，
   但那个 tag 太小，用户没注意到 —— 于是写入时压根没生成语音。
3. **测试骗人。** T9 一遇到无后端就 `skipSection`，`test:core` 常年
   "102 通过 · 0 失败"，功能坏了却没人知道。

### 17.3 修复

- **`pythonCandidates()` 大幅扩面**：`IPODTOOLS_PYTHON` → PATH → 官网安装包
  （扫 `Python3*` **全部版本**，不再写死 311）→ conda / scoop →
  **自动化工具链自带的隔离 venv**（`~/.workbuddy/binaries/python/envs/*/Scripts/python.exe`）。
  另加 `likelyHasWin32Com()`：先看 `site-packages/win32com` 目录**免启动**筛一遍，
  把有 pywin32 的排前面 —— 否则要为每个候选 spawn 一次 Python（每次约 100 ms）。
- **T9 由「跳过」改为「失败」**：没有可用后端时明确报 `✗`，并给出
  `pip install pywin32` / 设 `IPODTOOLS_PYTHON` 两条修法。
  **语音是核心功能，"环境不具备"不能当作通过。**
- **新增「补齐语音」入口**：写入流程本来就只补缺的那几首（已有语音直接跳过），
  所以当本地没有新歌、而设备上有曲目缺语音时，`btnWrite` 退化成
  「补齐语音（N 首）」并可点。**没有增加按钮，也没有新增参数分支**
  （`addSources=[]`、`removeIds=[]`、`pruneOrphans=false`）。
- **T2b 断言松绑**：原断言"设备上每首都必须有语音"，在设备被改造过之后必然误报。
  改为只守"不存在对不上任何曲目的语音文件"，缺语音情况降级为信息输出
  —— 批量制造缺语音的根因由 T9 把关。

### 17.4 验证

- `npm run test:core` → **102 通过 · 0 失败 · 0 跳过**
  （T9 真跑：后端 python，「2009年06月六级听力真题」→ 3.75 s / 165286 字节 PCM，
  Apple 4096 容器）
- `npm run test:ui` → **44 通过 · 0 失败**（新增 2 条：退化文案正确 +
  退化后参数里仍不含任何删除指令）
- `scripts/diag-tts.cjs`：**不设任何环境变量**，自动发现
  `envs\default\Scripts\python.exe`，实际合成成功

### 17.5 新增诊断脚本

- `scripts/diag-tts.cjs` —— 一屏看清：后端是否可用、走哪条路、有哪些中文语音、
  实际合成是否成功，以及 dbid → 语音文件名的溯源。
- `scripts/inspect-backups.cjs` —— 盘点 `backups/` 下所有 iTunesSD：曲目数、
  VoiceOver 总开关、逐曲 dbid 与期望语音文件名，并输出**随时间的变化时间线**。
  可带设备路径（`node scripts/inspect-backups.cjs F:/`）对照在线设备。

### 17.6 遗留

- 打包后的 exe 仍依赖「目标机器存在可用 TTS 通路」（PowerShell，或 Python + pywin32）。
  当前候选扫描含 `~/.workbuddy/...`，所以**本机**打包后开箱可用；换机器需对方满足其一。
- 设备上 `LLOI.mp3`「庐州月」的语音尚缺，点一次「补齐语音」即可补上。


## 18. 项目改名 + 语音后端探测改静态判定（2026-09-15 追加）

### 18.1 改名：「iPod 音乐管家」→「Shuffle 管家 / ShuffleMate」

**原因**：`iPod` 是 Apple 的注册商标，放进产品名有实际风险。描述性使用（「适用于
iPod Shuffle」）是安全的，所以**保留**在 README 正文与 `description` 里，用来保住可搜索性。

| 位置 | 旧 | 新 |
|---|---|---|
| `package.json` → `name` | `ipod-tools` | `shufflemate` |
| `package.json` → `productName`（含 `build` 内） | `iPod 音乐管家` | `Shuffle 管家` |
| `package.json` → `build.appId` | `com.ipodtools.shuffle` | `com.shufflemate.app` |
| `build.nsis.shortcutName` | `iPod 音乐管家` | `Shuffle 管家` |
| 窗口 `title` / 界面 `<title>` / 界面 `<h1>` | `iPod 音乐管家` | `Shuffle 管家` |

**环境变量做兼容而非硬切**：前缀改为 `SHUFFLEMATE_*`（`SHUFFLEMATE_PYTHON` /
`SHUFFLEMATE_TTS` / `SHUFFLEMATE_SOFTWARE_RENDER`），旧名 `IPODTOOLS_*` 仍作兜底
（见 `voiceover.ts` 的 `envCompat()`）。理由：用户机器上可能已经设过旧变量，
改名不该打断既有配置。

**项目目录 `ipodTools/` 刻意不改** —— 改目录会打断已配好的路径、快捷方式与使用习惯，
收益近乎为零。

### 18.2 探测改用静态判定（这次真正的坑）

改名后跑回归，T9 报「存在可用的语音合成后端」**失败** —— 而同一探测当天早些时候还是好的。
逐层实测（`time` 取 `real`）：

```
envs/default/Scripts/python.exe -c "pass"                    → 30.5 s
envs/default/Scripts/python.exe -c "import win32com.client"  → 30.8 s
versions/3.13.12/python.exe     -c "pass"                    → 20.4 s
```

`real` 20~30 秒，而 `user` 0.08 s / `sys` 0.00 s —— **全程在等 I/O，不是 CPU 忙**，且稳定复现。
结论：这台机器上**任何 Python 冷启动都要 20~30 秒**（典型的企业 EDR / Defender 实时扫描
或磁盘压力），与 venv 的 `.pth`、与本次改名**都无关**（连基础解释器空跑也一样慢）。

而 `pythonHasWin32()` 原来给每个候选 **15 秒**超时并逐个实测 —— 于是**所有候选一律超时**，
后端被判为不可用 → 界面自动取消勾选并禁用语音开关 → 用户看到的就是「新导入的歌不播报」。

> **这是 §17 那个 bug 的第二种成因。** 上次是「找不到那个装了 pywin32 的解释器」，
> 这次是「找到了，但探测不过来」。同一个症状，两条完全不同的路径。

修复：

- `pythonHasWin32()` 增加**快路径**：`site-packages\win32com` 目录存在就直接采信，
  **一次进程都不启**。检测从分钟级降到毫秒级，也不再受机器负载影响。
  代价可控：pywin32 真坏了也只是在合成那一步报错（有 `warnings` 兜底），
  不会比「静默判定无后端」更糟。
- 原逐个实测降级为**慢路径**（仅在没有任何静态证据时才走），并加 **30 秒总预算**兜底 ——
  否则候选扫描面铺开（PATH + 各版本 + 各 conda + 工具链 envs）后，慢机器上启动会卡几分钟。
- 合成超时 `60 s → 180 s`；`listVoicesViaPython` `30 s → 120 s`。
  慢机器上 Python 冷启动就吃掉 30 秒，原来的 60 秒余量太紧，
  会把「机器忙」和「后端坏了」表现成一回事。

验证：`diag-tts.cjs` 恢复 `backend: "python"`，语音枚举出
`Microsoft Huihui Desktop - Chinese (Simplified)`。

**教训**：拿「启动子进程实测」当能力探测手段，在负载不受控的机器上不可靠 ——
超时阈值会把「慢」误判成「不可用」，而这类误判的后果是**功能被静默禁用、测试还显示全绿**。
能用文件系统事实判定的，就别启进程。



