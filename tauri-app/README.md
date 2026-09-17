# Shuffle 管家 - Tauri 版本

基于 Tauri v2 框架重构的 iPod Shuffle 音乐管理工具。

## 与 Electron 版本的对比

| 指标 | Electron | Tauri |
|------|----------|-------|
| 安装包体积 | ~78 MB | ~10-15 MB |
| 解压后体积 | ~269 MB | ~15-30 MB |
| 运行时内存 | ~100-150 MB | ~10-30 MB |
| 独立 exe | ❌ 需要安装 | ✅ 可以 |
| 启动时间 | ~2-3 秒 | <1 秒 |

## 环境要求

1. **Rust 工具链** (1.70+)
   ```bash
   # Windows
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```

2. **Node.js** (18+)

3. **Visual Studio C++ Build Tools** (Windows)
   - 安装 Visual Studio 2022 或 Build Tools
   - 勾选 "C++ build tools" 工作负载

4. **WebView2** (Windows 10/11 通常已内置)

## 安装依赖

```bash
# 安装前端依赖
npm install
```

## 开发模式

```bash
npm run tauri dev
```

这会在开发模式下启动应用，带有热重载。

## 构建生产版本

```bash
npm run tauri build
```

构建完成后，输出文件位于：
- `src-tauri/target/release/shufflemate.exe` - 独立可执行文件
- `src-tauri/target/release/bundle/msi/*.msi` - MSI 安装包
- `src-tauri/target/release/bundle/nsis/*.exe` - NSIS 安装包

## 项目结构

```
tauri-app/
├── src/                      # 前端代码 (TypeScript)
│   ├── index.html
│   ├── styles.css
│   └── app.ts               # 主应用逻辑
├── src-tauri/               # 后端代码 (Rust)
│   ├── src/
│   │   ├── main.rs         # 入口点
│   │   ├── lib.rs          # Tauri 命令注册
│   │   ├── device.rs       # 设备检测和文件系统操作
│   │   ├── itunessd.rs     # iTunesSD 二进制解析
│   │   └── types.rs        # 数据结构定义
│   ├── Cargo.toml          # Rust 依赖
│   └── tauri.conf.json     # Tauri 配置
└── package.json            # 前端依赖
```

## 迁移状态

### ✅ 已完成

- [x] 项目基础结构
- [x] Tauri 配置和构建系统
- [x] 设备检测 (find_ipod_roots)
- [x] 卷标读取 (PowerShell UTF-8 编码)
- [x] 磁盘空间统计
- [x] Music 目录扫描
- [x] iTunesSD 基础解析
- [x] 前端框架 (简化版)

### 🚧 待完成

- [ ] ID3 标签读取 (mp3/m4a)
- [ ] iTunesDB 解析 (获取标题回退)
- [ ] 完整的前端 UI 迁移 (从 Electron app.js)
- [ ] 同步引擎 (sync.ts → Rust)
- [ ] VoiceOver 语音生成 (TTS + WAV 打包)
- [ ] 文件备份功能
- [ ] 热插拔检测
- [ ] 完整的错误处理和用户反馈

## 关键差异

### 前端

- 使用 `@tauri-apps/api/core` 的 `invoke()` 替代 Electron 的 IPC
- 使用 `@tauri-apps/plugin-dialog` 替代 `dialog.showOpenDialog()`
- 使用 `@tauri-apps/plugin-shell` 执行系统命令

### 后端

- TypeScript → Rust
- `child_process.execFileSync` → `std::process::Command`
- `fs` → `std::fs`
- `path` → `std::path::Path`
- Buffer 操作 → `byteorder` crate
- PowerShell 调用保持相同，但编码处理更简洁

## 性能优化

Tauri 的 `Cargo.toml` 已配置 release 优化：

```toml
[profile.release]
panic = "abort"
codegen-units = 1
lto = true
opt-level = "s"
strip = true
```

这会生成更小、更快的可执行文件。

## 故障排查

### "cannot find -lWebView2Loader"

安装 WebView2 Runtime: https://developer.microsoft.com/en-us/microsoft-edge/webview2/

### "LINK : fatal error LNK1181: cannot open input file"

确保安装了 Visual Studio C++ Build Tools，并重启终端。

### PowerShell 命令输出乱码

已在 `device.rs` 中设置 UTF-8 编码：
```rust
"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8"
```

## 许可证

MIT
