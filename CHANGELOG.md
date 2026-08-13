# Changelog

## 0.3.0 — 内置 DSH 运行时（零依赖）

- **随包捆绑完整 DSH**：`scripts/bundle-dsh.mjs` 把本机 DSH 安装复制进 `vendor/dsh`（约 212 MB，自动裁剪 win32/darwin/musl 预编译二进制），electron-builder 通过 `extraResources` 打进安装包
- **零依赖运行**：内置 dsh 用 Electron 自带的 Node 运行时执行（`ELECTRON_RUN_AS_NODE=1` + `--expose-internals`），目标机器无需 Node.js / npm / dsh
- 运行时解析顺序：`DSH_BIN` → 内置 vendor/dsh → 机器已装 dsh（nvm / Homebrew / pnpm）→ `npx @deepseek-ai/dsh`
- Linux 产物：`deepseek-harness-desktop_0.3.0_amd64.deb` + `DeepSeek Harness Desktop-0.3.0.AppImage`（自包含）
- 进程组级关停（`process.kill(-pid)`）沿用自 0.2.0

## 0.2.0 — 苹果镜像

- 新增 **macOS / 苹果镜像**（Apple Silicon arm64）：`.app` + `.dmg`
- 产物名：`DeepSeek Harness Desktop-0.2.0-mac-arm64.dmg`
- 图标改为 GitHub 官方 UI 鲸鱼标（`#4D6BFE`）
- macOS 启动时自动加入 Homebrew PATH，找不到全局 `dsh` 时回退 `npx`
- macOS 保留原生应用菜单

Linux 镜像（deb / AppImage）从 0.1.0 起已存在，现随 0.2.0 继续提供。

## 0.1.0 — Linux 镜像

- 首个 Electron 桌面壳
- Linux 产物：`.deb` + `.AppImage`
- 自动端口、就绪探测、单实例、关窗停服务
