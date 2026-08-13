# Changelog

## 0.5.0 — 瘦安装包（待发布）

- Desktop 安装包不再携带完整 DSH，显著缩小 Desktop 下载体积；DSH 改为独立 Release 运行时资产
- 运行时解析顺序改为 `DSH_BIN` → 本机 `dsh` → 已校验缓存 → 首次下载固定的 `@deepseek-ai/dsh@0.1.0-rc.6`
- 首次下载校验 SHA-256 并按版本、平台和架构缓存；缓存命中后无需联网，终端用户仍无需 Node.js / npm
- 新增 Linux x64 一键安装脚本，从 GitHub Releases 下载并校验 AppImage；仍保留 AppImage、deb 与 macOS arm64 DMG 直接下载
- 一键安装脚本会写入 `~/.local/share/applications` 桌面入口和应用图标；deb/AppImage 改为打包 16–1024 全套 Linux 图标，避免 Ubuntu 应用列表只有名字没有图标
- Ubuntu 图标启动改为包装脚本：没有 `libfuse.so.2` 时先解包再启动，避免点图标毫无反应
- 桌面入口关闭 StartupNotify、去掉空的 `%U`，并直接启动解包后的 Electron 二进制，避免 GNOME 误判启动失败
- `npx deepseek-harness-desktop` 在 Linux 上同样写入应用菜单入口和图标
- 启动前检查 Node.js 18+；缺失或过旧时 `setup.sh` / `setup.ps1` 会下载官方 LTS 到用户目录（不覆盖系统 Node）再启动
- Windows：查找 `%APPDATA%\\npm\\dsh.cmd`，用 `shell` 启动 `.cmd`，并设置 AppUserModelId，避免任务栏图标对不上
- 新增 Linux x64、Linux arm64、macOS arm64 的原生运行时资产构建流程；每个 `.tar.gz` 同时发布 `.sha256`
- Linux 与 macOS 统一使用新版启动器安全区图标，并改用 macOS 15 arm64 runner 构建 DMG 与运行时
- 收紧本地 Web UI 的同源导航与 HTML 就绪检查，避免相似 URL 绕过和错误响应被误判为启动成功

## 0.4.0 — 自动更新

- 集成 **electron-updater**，更新源为 GitHub Releases（公开仓库，用户端无需凭据）
- AppImage 启动后自动检查更新并后台下载，完成后弹窗「立即重启安装 / 稍后」；退出时也会自动安装（`autoInstallOnAppQuit`）
- Linux 自动更新仅支持 **AppImage**；deb 安装包无法自替换，运行时会记录提示
- 更新链路测试开关：`DSH_DESKTOP_AUTOUPDATE_TEST=1`（下载完成即自动重启安装，用于 CI/验证）
- `--publish never` 固化到构建脚本；`latest-linux.yml` 随构建生成

## 0.3.1 — 官方 Web UI 鱼标

- 图标改为应用内 `FishLogo`（与侧栏 / 欢迎页同一条路径），不再用网站 favicon 加浅色卡片
- 深色底板对齐 Web UI（`#0F1115` / 主文字 `#F9FAFB`）
- 单层圆角、鱼标放大到 Dock 安全区

## 0.3.0 — 内置 DSH 运行时（零依赖）

- **随包捆绑完整 DSH**：`scripts/bundle-dsh.mjs` 把本机 DSH 安装复制进 `vendor/dsh`（约 212 MB，自动裁剪 win32/darwin/musl 预编译二进制），electron-builder 通过 `extraResources` 打进安装包
- **零依赖运行**：内置 dsh 用 Electron 自带的 Node 运行时执行（`ELECTRON_RUN_AS_NODE=1` + `--expose-internals`），目标机器无需 Node.js / npm / dsh
- 运行时解析顺序：`DSH_BIN` → 内置 vendor/dsh → 机器已装 dsh（nvm / Homebrew / pnpm）→ `npx @deepseek-ai/dsh`
- Linux 产物：`deepseek-harness-desktop_0.3.0_amd64.deb` + `DeepSeek Harness Desktop-0.3.0.AppImage`（自包含）
- 进程组级关停（`process.kill(-pid)`）沿用自 0.2.0

## 0.2.1 — 图标圆角与尺寸

- 官方鲸鱼标改为圆角底板，四周留白，适配 Dock / 桌面 / 多尺寸导出
- 产物：`DeepSeek Harness Desktop-0.2.1-mac-arm64.dmg`

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
