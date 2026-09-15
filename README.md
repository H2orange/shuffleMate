# Shuffle 管家（ShuffleMate）

> 面向 **iPod Shuffle 第 4 代** 的 Windows 桌面音乐管理工具（名字取自设备型号，故为 **ShuffleMate**）。
> 增删歌曲、重建播放数据库、生成中文 VoiceOver 语音播报 —— 全程自动备份、写后校验。

iPod Shuffle 没有屏幕，歌曲全靠语音播报（VoiceOver）来辨认。这款设备已经停产，现行 iTunes 也不再支持它；而它的播放数据库是一个未公开的二进制文件，任何一个字节写错都可能让设备无法正常播放。本项目就是为了解决这件事 —— 用一套**可验证、可回滚**的流程，安全地往设备里加歌、删歌并补齐中文播报。

> ⚠️ 独立的第三方工具，与 Apple Inc. 无任何隶属或赞助关系。iPod、iPod shuffle、iTunes 是 Apple Inc. 的商标，此处仅用于说明兼容性。详见 [声明](#声明)。

---

## 功能特性

| 功能 | 说明 |
|---|---|
| 📥 **写入歌曲** | 从本地选文件/文件夹导入到设备，自动分配存储目录（`F00` / `F01` …） |
| 🗑️ **移除歌曲** | 勾选即标记，二次确认后删除音频文件与数据库记录 |
| 🗣️ **中文 VoiceOver** | 为缺失播报的曲目合成中文语音（SAPI5），支持语速、发音人、采样率配置 |
| 🧹 **一致性清理** | 自动清除失效记录、未登记文件、无主语音文件，保证数据库与磁盘严格一致 |
| 🔌 **热插拔识别** | 插入/拔出设备 1 秒内自动刷新界面状态，无需重启 |
| 💾 **自动备份** | 每次改动 `iTunesSD` 前备份到 `backups/<时间戳>-prechange/` |
| 🛡️ **写后校验** | 原子替换 + 回读比对，校验不通过即中止并保留原文件 |
| 🎨 **界面** | 清新简约风格，彩色容量条、曲目来源标注（ID3 / iTunesDB / 文件名） |

---

## 环境要求

- **系统**：Windows（依赖 SAPI5 做语音合成，依赖盘符探测设备）
- **设备**：iPod Shuffle 第 4 代，FAT32 格式
- **运行时**：Node.js 18+（开发用）
- **语音后端**：以下任一即可（按顺序尝试）
  1. **PowerShell** + `System.Speech`（Windows 自带，但可能被企业安全策略拦截）
  2. **Python 3** + `pywin32` → `pip install pywin32`

  两者都不可用时，界面会提示「语音后端不可用」并自动禁用语音生成开关，其余功能不受影响。

---

## 快速开始

```bash
# 1. 安装依赖（会下载约 100MB 的 Electron 运行时）
npm install

# 国内网络建议先设镜像
npm config set electron_mirror https://npmmirror.com/mirrors/electron/

# 2. 编译并启动
npm start
```

启动后插入 iPod，设备栏会自动出现并开始读取曲库。

**其他启动方式**

```bash
npm run dev        # 带 --dev，可开 DevTools 调试
npm start:sw       # 软件渲染，老显卡 / 虚拟机渲染异常时使用
npm run dev:sw     # 以上两者结合
```

### 使用流程

1. **写入** —— 点「选择文件 / 文件夹」，勾选要导入的曲目，点 **「写入 iPod（N 首）」**。这是**非破坏性**操作，不需要二次确认。
2. **移除** —— 在设备曲目列表里勾选（勾选 = 标记移除），点 **「移除 N 首」**，确认后执行。这是**破坏性**操作，会二次确认。
3. **补齐语音** —— 若设备上有曲目缺 VoiceOver，写入按钮会自动变成 **「补齐语音（N 首）」**，点一下只补缺的语音文件，不动任何音频。
4. **安全弹出** —— 改动完成后点「安全弹出」，等系统提示可以拔出再拔线（FAT32 写缓存会吞掉数据库）。

> 写入与移除是**两个独立按钮**，参数层完全隔离：写入只增不减，移除只减不增。这是刻意的设计，避免一个按钮同时干两件相反的事导致误操作。

---

## npm 脚本

| 命令 | 作用 |
|---|---|
| `npm run build` | TypeScript 编译到 `dist/` |
| `npm start` | 编译 + 启动应用 |
| `npm run dev` | 编译 + 启动（带调试开关） |
| `npm run test:core` | 核心回归测试（**不需要真机**） |
| `npm run test:ui` | 界面自检（Electron 无头运行） |
| `npm run test:hotplug` | 热插拔链路验证（**需要真机**） |
| `npm run test:all` | `test:core` + `test:ui` |
| `npm run test:device` | 真机端到端测试：导入 → 合成语音 → 删除 → 还原 |
| `npm run device:restore` | 从备份恢复设备曲库 |
| `npm run device:clean` | 清理设备上的孤儿文件 |
| `npm run package` | 打包为 NSIS 安装包（输出到 `release/`） |
| `npm run package:dir` | 只生成未压缩的目录版（快速验证打包产物） |

---

## 目录结构

```
src/
  main/
    index.ts            主进程：窗口、IPC 路由、热插拔轮询
    core/
      types.ts          全部接口定义
      itunessd.ts       iTunesSD 解析 / 构建（设备播放数据库）
      itunesdb.ts       只读解析 iTunesDB（补标题、艺术家）
      audio.ts          MP3 帧遍历、M4A 解析、ID3/MP4 标签、时长
      fsx.ts            原子写入、缓冲刷盘、备份、受控删除
      voiceover.ts      dbid、语音文件名、WAV 解析、Apple 容器、双后端 TTS
      device.ts         设备发现 + 曲库加载（三级标题回退）
      library.ts        本地文件扫描与导入前预检
      sync.ts           syncDevice 主流程
      hotplug.ts        拔插去抖（StableDetector）
  preload/
    index.ts            contextBridge 暴露的 window.ipod API
  renderer/
    index.html          界面结构
    styles.css          样式
    app.js              界面逻辑
assets/                 应用图标（SVG 母版 + 多尺寸 PNG + ICO）
scripts/                测试与诊断脚本
tools/                  格式逆向参考实现（Python，仅供对照）
backups/                改动前的设备数据库备份（自动生成，不入版本库）
PLAN.md                 完整设计文档：格式规范、决策记录、踩坑复盘
```

---

## 工作原理

### 唯一的真相来源

设备上有两套并行的数据：`Music/` 目录里的实际音频文件，和 `iTunes/iTunesSD` 里登记播放顺序的二进制数据库。两者一旦不一致，设备就会播放失败甚至卡死。

本项目把 **`Music/` 目录当作唯一真相来源**：

- `iTunesDB` **只读不写**，仅用来补全标题、艺术家等元数据
- 同步完成后，严格保证 `Music/` 下的文件集合 ≡ `iTunesSD` 登记的曲目集合
- `Device/`、`Speakable/System`、`Speakable/Messages` **永不触碰** —— 这些是设备固件资源

### iTunesSD 格式要点

- 根头魔数 `bdhs`，第 29 字节是 **VoiceOver 总开关**
- 每条曲目记录含路径（UTF-8，用 `/` 分隔）、时长、采样数、dbid 等字段
- **无 hash / 无签名**，因此可以安全重建；写入采用原子替换
- 每条记录有固定长度，增删曲目 = 重排整张表

### VoiceOver 命名规则

语音文件名由曲目的 `dbid` 决定：

```
Speakable/Tracks/<dbid 按字节倒序、大写十六进制>.wav
```

本工具对**新曲目**用 `md5(播报文本)[:8]` 生成 dbid，保证同一首歌重复写入产生相同文件名（幂等）；对**设备已有曲目**保留其原始 dbid，避免重建时把已有语音全部作废、重新合成一遍（13 首歌要多花好几分钟）。

播报文本的合成产物必须是 **Apple 特有的 4096 字节容器**（`data` 块精确落在 `0x1000` 偏移），而非普通 WAV —— 格式不对设备会直接忽略。

### 变更安全链

```
读取现状 → 生成计划 → 备份 iTunesSD → 原子写入 → 回读校验 → 清理孤儿
                                      ↓ 校验失败
                                   中止并保留原文件
```

删除是**受控删除**：有三道闸门（数量比例、路径白名单、文件类型），异常情况会保留文件并在结果里报 `orphanKept`，而不是硬删。

---

## 测试

```bash
npm run test:core      # 核心回归：102 项，无需真机
npm run test:ui        # 界面自检：44 项
npm run test:hotplug   # 热插拔：14 项，需要真机
```

`test:core` 覆盖：字节级往返一致、语音命名、Apple 容器格式、MP3 元数据对齐、iTunesDB 解析、端到端同步、语音全链路幂等、一致性收敛、TTS 合成、拔插去抖。

**写测试的两条硬规矩**（都踩过坑，详见 `PLAN.md`）：

1. **素材必须取自「设备当前实际内容」，不得钉死特定曲目与采样率。**
   曾经把 13 首原始曲目写进测试当基线，而这几首正是本工具被用来删掉的对象 —— 用户一删，测试就莫名崩溃。
2. **不许用「跳过」掩盖「环境不具备」。**
   语音合成测试曾因后端缺失就 `skipSection`，导致长期显示全绿，而功能实际早已失效，用户上了机器才发现。核心功能的后端缺失必须**报失败**。

---

## 打包

```bash
# electron-builder 首次运行需下载工具链，国内直连 GitHub 会卡死，先设镜像：
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
# Windows CMD: set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/

npm run package
```

产物在 `release/`，NSIS 安装包约 **71 MiB**（解包后约 269 MiB，其中 99.9% 是 Electron 运行时）。

---

## 常见问题

**Q：界面图标还是 Electron 默认的？**
从源码启动时窗口图标读的是 `assets/icon.ico`；若显示为默认图标，确认 `npm run build` 之后重启应用，并检查 `assets/icon.ico` 存在。

**Q：为什么写入后新歌没有语音播报？**
检查界面底栏的语音后端状态。PowerShell 被安全策略拦截 + Python 没装 pywin32 时，语音后端不可用，开关会被自动关闭且禁用。装个 `pywin32` 即可：

```bash
pip install pywin32
# 或指定解释器（需已装 pywin32）
set SHUFFLEMATE_PYTHON=C:\path\to\python.exe
```

> 本项目原名「iPod 音乐管家」，2026-09-15 改名为 **Shuffle 管家 / ShuffleMate**。
> 环境变量前缀随之改为 `SHUFFLEMATE_*`，但旧的 `IPODTOOLS_*`（如 `IPODTOOLS_PYTHON`、
> `IPODTOOLS_TTS`、`IPODTOOLS_SOFTWARE_RENDER`）**仍然兼容**，无需改动既有配置。

诊断：`node scripts/diag-tts.cjs` —— 一屏看清走的后端、可用的中文发音人、实际合成结果。

**Q：点写入后语音那一步卡很久才出来？**
慢机器上 `python.exe` 冷启动本身可能就要 20~30 秒（企业 EDR / Defender 的实时扫描会拖慢
每一次解释器启动），再叠加合成本身的几秒，看起来就像卡住 —— 属正常现象，不是死锁。
后端探测已改为**读 `site-packages\win32com` 目录**来判定，不再依赖启动实测，
所以不会再把「慢」误判成「不可用」而静默关掉语音开关。

**Q：设备上有曲目缺语音，不想重新导入怎么办？**
点底栏的「补齐语音（N 首）」按钮，只补缺的那几个语音文件。

**Q：怎么盘点设备与备份里每首歌的语音状态？**
`node scripts/inspect-backups.cjs F:/`

**Q：在 CI / 沙箱里 `electron` 被当成 Node 跑，报 `app is not defined`？**
环境里存在 `ELECTRON_RUN_AS_NODE=1`。临时清掉：

```bash
env -u ELECTRON_RUN_AS_NODE electron .
```

**Q：改了设备内容想还原？**
`npm run device:restore` 从 `backups/` 里挑一个备份恢复。

---

## 开发约定

- 所有子进程调用必须用**绝对路径** —— 本机 nvm4w 环境会让 Electron 派生的子进程丢失 `System32`，导致 `powershell.exe` 等报 `ENOENT`。
- 破坏性操作前必须备份，写后必须回读校验。
- 测试不得依赖特定曲目、特定采样率。
- 完整设计文档见 [`PLAN.md`](./PLAN.md)，包含 iTunesSD 二进制格式规范、每一条架构决策的理由、以及历次踩坑复盘。

## 声明

### 商标：与 Apple 无隶属关系

本项目是**独立的第三方工具**，与 Apple Inc. **不存在任何隶属、合作、赞助或认可关系**。

iPod、iPod shuffle、iTunes、VoiceOver 是 Apple Inc. 在美国及其他国家和地区注册的商标。
本项目仅在**描述兼容性**时以纯文字形式提及这些名称（如「适用于 iPod Shuffle 第 4 代」
「iPod Shuffle 曲库」）：**未使用**任何 Apple 的图形标志、Logo 或图标，产品名中**不含**
任何 Apple 商标。提及这些名称的唯一目的是说明本工具与何种设备配合使用。

> 本节的写法依据 Apple 官方
> [《Guidelines for Using Apple Trademarks and Copyrights》](https://www.apple.com/legal/intellectual-property/guidelinesfor3rdparties.html)
> 中「兼容性引用」的要求：不把 Apple 商标用作产品名、不以比本项目名称更显著的方式展示它、
> 不暗示 Apple 对本项目的认可或赞助、不以贬损方式使用。

### 反向工程与格式说明

`PLAN.md` 中记录的 iTunesSD 二进制格式，来自对**自有设备**上、由设备自身生成的数据库文件
的观察与实测，属于为实现互操作性所必需的接口信息：

- **未**使用、复制或分发任何 Apple 的源代码、固件或二进制程序；
- **未**绕过任何加密、签名或版权保护措施 —— 该数据库本身不含这些机制（无 hash、无签名）；
- 全部实现均为独立编写，出发点仅是**文件格式**这一功能性事实。

为实现互操作性而进行的此类反向工程，在多数法域下属合法行为（可参考美国的
*Sega v. Accolade*、*Sony v. Connectix* 判例，以及 DMCA §1201(f) 的互操作性例外）。

### 使用限制

- 请**仅对自己的设备**使用本工具。
- 本工具**不用于**处理受 DRM 保护的音乐（如 FairPlay 加密的 `.m4p`）。要导入的文件请自行
  从合法渠道取得无 DRM 版本。
- 本工具会**直接改写设备的播放数据库**，而该格式并未公开。尽管本项目实现了自动备份、
  原子替换与写后校验，**仍无法保证在所有设备与固件组合上都不出问题**。请先备份重要数据，
  并自行承担使用风险。

### 无保修

本软件按「原样」提供，不附带任何形式的明示或默示担保。作者不对因使用本软件造成的
设备损坏、数据丢失或其他任何损失负责。完整条款见 [LICENSE](./LICENSE)。

### 第三方组件

本项目基于 Electron 构建。以**源码**形式分发本仓库不涉及再分发这些组件；
但**打包分发**安装包时会一并分发 Electron 运行时及其内含的开源组件
（Electron：MIT；Chromium 及其依赖：BSD 等），届时需随附相应的许可与版权声明。

> ⚠️ 若将来引入 `ffmpeg` 之类的外部程序来扩展格式转换能力，务必先确认其构建版本的许可：
> `ffmpeg-static` 分发的是 **GPL** 构建，随附分发会要求整个应用以 GPL 兼容方式发布；
> 需要规避时应改用 LGPL 构建。本项目目前**未**打包任何 ffmpeg。

## 许可

以 [MIT 许可](./LICENSE) 发布 —— 可自由使用、修改、分发，需保留版权声明。

