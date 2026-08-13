# Changelog

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
