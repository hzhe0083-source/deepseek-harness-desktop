# Changelog

## 0.5.0 — 跟随官方 Harness 与桌面自更新（开发中）

- **无需人工盯 DSH 版本**：仓库不写死具体 Harness 版本；发布流程每 6 小时检查官方 npm `latest`，只有上游变化时才准备一批新版本，也支持需要时手动强制发布
- **macOS / Linux 共用一次解析结果**：每批发布只生成一份带锁文件和完整性信息的临时快照，两个平台使用同一个 DSH 版本，再分别安装和验证各自的原生依赖
- **完整运行时组装**：不再只复制 DSH 包目录或按固定平台名单裁剪依赖；每个目标平台从同一快照安装完整生产依赖，并用 Electron 自带的 Node 验证 CLI、Web 服务与原生模块
- **桌面自更新**：macOS 与 Linux AppImage 可在后台检查、下载并提示安装；Linux deb 为避免应用直接操作系统包管理器，改为打开 GitHub Releases 手动更新
- **更新过程不中断工作**：后台检查失败只记日志，手动检查才显示明确结果；安装更新前会先安全停止本地 DSH 服务
- **macOS 发布保护**：正式自动更新要求 Developer ID 签名与 Apple 公证；用户需要先手动安装首个正式签名版，之后即可继续应用内更新
- **签名凭据隔离**：DSH 的安装与真实烟测在无秘密的原生任务中完成；全新的 macOS 签名任务不执行上游代码，只签名、公证并复核已验证归档
- **更新信任链门禁**：正式发布要求默认分支保护、仅允许默认分支的 `production-release` Environment，以及 GitHub Immutable Releases；任一项缺失都会安全停止
- **原子发布**：Linux 与 macOS 都构建成功后才创建 Release，避免出现只有单个平台或缺少更新元数据的半成品发布
- 本条记录描述 0.5.0 开发线能力，不表示本地构建已经发布

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
