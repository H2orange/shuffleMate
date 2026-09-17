# Shuffle 管家 Tauri 版本 - 安装与构建指南

## 环境准备

### 1. 安装 Rust 工具链

**Windows:**
```powershell
# 下载并运行 rustup 安装程序
Invoke-WebRequest -Uri "https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe" -OutFile "$env:TEMP\rustup-init.exe"
& "$env:TEMP\rustup-init.exe" -y --default-toolchain stable --profile minimal

# 重启 PowerShell 或执行：
$env:PATH += ";$env:USERPROFILE\.cargo\bin"

# 验证安装
rustc --version
cargo --version
```

### 2. 安装 Visual Studio Build Tools

1. 下载 [Visual Studio Build Tools 2022](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
2. 运行安装程序
3. 勾选 **"C++ build tools"** 工作负载
4. 在右侧勾选 **"MSVC v143 - VS 2022 C++ x64/x86 build tools"**
5. 勾选 **"Windows 10 SDK"** 或 **"Windows 11 SDK"**
6. 点击安装

### 3. 安装 Node.js

下载并安装 [Node.js 18+](https://nodejs.org/)

### 4. 验证 WebView2

Windows 10 (1803+) 和 Windows 11 通常已内置 WebView2。如需手动安装：
- 下载 [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)

## 项目构建

### 安装依赖

```bash
cd E:\AI\vibe-coding\shuffleMate\tauri-app
npm install
```

### 开发模式

```bash
npm run tauri dev
```

这会：
1. 启动 Vite 开发服务器 (端口 1420)
2. 编译 Rust 后端
3. 启动 Tauri 应用窗口
4. 支持热重载

### 生产构建

```bash
npm run tauri build
```

构建产物位置：
- **独立 exe**: `src-tauri/target/release/shufflemate.exe`
- **MSI 安装包**: `src-tauri/target/release/bundle/msi/Shuffle 管家_0.1.0_x64_en-US.msi`
- **NSIS 安装包**: `src-tauri/target/release/bundle/nsis/Shuffle 管家_0.1.0_x64-setup.exe`

## 项目结构

```
tauri-app/
├── src/                          # 前端 (TypeScript)
│   ├── index.html               # 从原项目复制
│   ├── styles.css               # 从原项目复制
│   └── app.ts                   # Tauri API 调用
├── src-tauri/                   # 后端 (Rust)
│   ├── src/
│   │   ├── main.rs             # 入口点
│   │   ├── lib.rs              # Tauri 命令注册
│   │   ├── device.rs           # 设备检测 (find_ipod_roots, volume_label)
│   │   ├── itunessd.rs         # iTunesSD 二进制解析
│   │   ├── types.rs            # 数据结构定义
│   │   ├── audio.rs            # MP3 时长读取 (简化版)
│   │   ├── fsx.rs              # 文件系统工具函数
│   │   ├── voiceover.rs        # TTS 语音生成
│   │   ├── sync.rs             # 同步引擎
│   │   └── hotplug.rs          # 热插拔检测
│   ├── Cargo.toml              # Rust 依赖
│   └── tauri.conf.json         # Tauri 配置
├── package.json                 # 前端依赖
└── README.md                    # 项目说明
```

## 与 Electron 版本的对比

| 指标 | Electron | Tauri |
|------|----------|-------|
| 安装包体积 | ~78 MB | **~10-15 MB** |
| 解压后体积 | ~269 MB | **~15-30 MB** |
| 运行时内存 | ~100-150 MB | **~10-30 MB** |
| 启动时间 | ~2-3 秒 | **<1 秒** |
| 独立 exe | ❌ 需要安装 | ✅ 可以 |

## 迁移完成度

### ✅ 已完成

- [x] Tauri 项目结构和配置
- [x] 设备检测 (`find_ipod_roots`)
- [x] 卷标读取 (PowerShell UTF-8)
- [x] 磁盘空间统计
- [x] Music 目录扫描
- [x] iTunesSD 基础解析
- [x] 文件系统工具 (`fsx.rs`)
- [x] VoiceOver 框架 (`voiceover.rs`)
- [x] 同步引擎框架 (`sync.rs`)
- [x] 热插拔检测框架 (`hotplug.rs`)
- [x] 前端框架 (简化版)

### 🚧 待完善

- [ ] 完整 ID3 标签读取 (mp3/m4a)
- [ ] iTunesDB 解析 (标题回退)
- [ ] 完整前端 UI 迁移 (从 Electron app.js)
- [ ] 完整 iTunesSD 序列化 (build_sd)
- [ ] VoiceOver WAV 格式转换优化
- [ ] 文件备份功能完善
- [ ] 完整错误处理和用户反馈

## 常见问题

### Q: 编译时提示 "cannot find -lWebView2Loader"

**解决**: 安装 WebView2 Runtime，或更新 Windows 到 1803+ 版本。

### Q: 提示 "LINK : fatal error LNK1181"

**解决**: 确保安装了 Visual Studio C++ Build Tools，并重启终端。

### Q: PowerShell 命令输出乱码

**解决**: 已在代码中设置 UTF-8 编码：
```rust
"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8"
```

### Q: 如何添加图标？

**解决**: 将图标文件放入 `src-tauri/icons/` 目录：
- `icon.ico` (Windows)
- `icon.icns` (macOS)
- `32x32.png`, `128x128.png`, `128x128@2x.png`

## 下一步

1. 安装 Rust 和 Build Tools
2. 运行 `npm install`
3. 运行 `npm run tauri dev` 测试开发模式
4. 运行 `npm run tauri build` 构建生产版本
5. 对比 Electron 和 Tauri 版本的体积和性能

## 许可证

MIT
