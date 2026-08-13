# DeepSeek Harness Desktop

Electron 桌面壳，把 **DeepSeek Harness (DSH)** 的 Web UI 包进一个原生窗口。**从 0.3.0 起安装包自带完整 DSH 运行时（零依赖），从 0.4.0 起 AppImage 支持自动更新到最新版。**

仓库地址：<https://github.com/hzhe0083-source/deepseek-harness-desktop>

应用本身不重写任何 harness 逻辑：它在本机找一个空闲的 `127.0.0.1` 端口，启动 `dsh web`，等服务真正就绪后再把沙箱化的 `BrowserWindow` 指过去。关闭窗口即停止服务并退出。

## 平台镜像版本

当前应用版本：**0.4.1**

| 镜像 | 版本 | 架构 | 产物 | 状态 |
| --- | --- | --- | --- | --- |
| **Linux** | 0.1.0 起，现随 0.4.1 | x64 / 本机 | `.deb` + `.AppImage` | **已有（0.3.0 起内置 DSH;0.4.0 起 AppImage 自动更新）** |
| **macOS / 苹果镜像** | 0.2.0 起，现随 0.3.1 | Apple Silicon (arm64) | `.app` + `.dmg` | **已有** |
| Windows | — | x64 | `.exe` (NSIS) | 配置已预留，尚未作为正式镜像发布 |

- Linux 镜像：`npm run dist:linux`（`bundle:dsh` 自动先执行）
- 苹果镜像：`npm run dist:mac`
  产物名：`DeepSeek Harness Desktop-<版本>-mac-arm64.dmg`
  以及未打包目录：`dist/mac-arm64/DeepSeek Harness Desktop.app`

GitHub Releases 里请认准版本号与文件名（`v0.4.1`、`mac-arm64` / `.deb` / `.AppImage`）。Intel Mac 不在当前镜像范围内。

图标使用官方 Web UI 的 `FishLogo`（与侧栏 / 欢迎页同一条路径），深色底板、单层圆角，按 Dock 尺寸放大。

## 自动更新（0.4.0+）

- 更新源：GitHub Releases（公开仓库，无需凭据）；electron-updater 读取发布里的 `latest-linux.yml`
- 行为：启动后约 8 秒后台检查 → 有新版本自动下载 → 下载完成弹窗「立即重启安装 / 稍后」；选择稍后则退出应用时自动安装
- **仅 AppImage 支持自动更新**（Linux 上 deb 无法自替换）；deb 用户请从 Releases 手动下载新版
- 更新日志在 `~/.config/DeepSeek Harness Desktop/logs/dsh-server.log`（`[updater]` 前缀）

## 特性

- **自动更新（0.4.0+，AppImage）** —— 后台检查/下载 GitHub Releases 最新版，一键重启安装
- **开箱即用的内置运行时（0.3.0+）** —— 随包分发完整 DSH（vendor/dsh，含全部依赖与前端产物），在 **Electron 自带的 Node 运行时**上执行（`ELECTRON_RUN_AS_NODE=1`），无需系统 Node / npm / dsh
- **外部 dsh 仍可用** —— 设 `DSH_BIN` 可强制指向外部安装的 dsh；没有 vendor 的源码构建自动回退到机器上已装的 dsh，最后回退 `npx @deepseek-ai/dsh`
- **共享同一份数据** —— 会话、设置、preset、skills 全部沿用 `~/.dsh` 里的数据，和浏览器里用的是同一份
- **自动端口选择** —— 不占用固定端口，和已开着的 `dsh web`（如 3080）互不冲突
- **启动就绪探测** —— 轮询直到 SPA 真的开始响应才开窗；`dsh` 启动失败/退出会弹出带日志的错误框
- **单实例锁** —— 重复启动时聚焦已有窗口
- **安全默认** —— `contextIsolation` + `sandbox` + 无 `nodeIntegration`，外链一律交给系统浏览器
- **服务生命周期** —— 关窗 → `SIGTERM` 停止 dsh（进程组）→ 退出；3 秒兜底 `SIGKILL`
- **苹果镜像额外处理** —— 自动带上 Homebrew PATH（`/opt/homebrew/bin`）；macOS 保留原生应用菜单

## 运行时解析顺序

启动时按以下优先级选择如何运行 dsh：

1. `DSH_BIN` 环境变量（显式指定的外部 dsh 启动器）
2. 内置 `vendor/dsh`（打包版在 `resources/vendor/dsh`），用 `process.execPath` + `--expose-internals` + `ELECTRON_RUN_AS_NODE=1` 在 Electron 的嵌入式 Node 上运行
3. 机器上已装的 `dsh`（nvm / Homebrew / pnpm / npm-global 常见位置）
4. `npx --yes @deepseek-ai/dsh`（首次较慢，启动超时放宽到 180 秒）

`--expose-internals` 是 DSH 的 HMR 服务所要求的 V8 标志；DSH 自带的 `node-addon-require-builtin` 兜底在 Electron 的 Node 下不可用，因此显式传入。

## 使用

**终端用户**：从 Release 下载对应平台的镜像，安装即用（0.3.0 起零依赖）。

**源码开发/构建**：

```sh
npm install
npm run bundle:dsh   # 把本机(或 DSH_INSTALL_DIR 指向的)DSH 安装复制进 vendor/dsh
npm start            # 开发运行(无 vendor 时自动回退到机器 dsh / npx)
```

如果 `dsh` 不在 PATH 中（例如用 nvm 安装的），可设置环境变量指向它：

```sh
DSH_BIN=/path/to/dsh npm start
```

### 苹果镜像（macOS）

1. 从 Release `v0.3.1` 下载 `DeepSeek Harness Desktop-0.3.1-mac-arm64.dmg`，或本地构建：

```sh
npm install
npm run dist:mac
```

2. 打开 dmg，把 **DeepSeek Harness Desktop.app** 拖到「应用程序」，或直接运行：

```sh
open "dist/mac-arm64/DeepSeek Harness Desktop.app"
```

3. 未签名的本地构建，第一次打开若被拦截：系统设置 → 隐私与安全性 → 仍要打开。也可：

```sh
xattr -cr "DeepSeek Harness Desktop.app"
```

### Linux 镜像

```sh
npm install
npm run dist:linux
```

产物在 `dist/`：`.deb` 和 `.AppImage`。

## 工作原理

```
Electron main ──spawn──> <electron 二进制> --expose-internals vendor/dsh/lib/bin.js
                             └ web --host 127.0.0.1 --port <free-port>
                          (ELECTRON_RUN_AS_NODE=1 → 作为 Node 运行)
     │                        │
     │  poll GET / until 200  │
     │<───────────────────────┘
     │
BrowserWindow ──loadURL──> http://127.0.0.1:<port>
```

DSH 的服务端对 IP 字面量的 host 天然放行（无 DNS rebinding 风险），Electron 里加载 `http://127.0.0.1:<port>` 与浏览器访问完全等价。

## 打包分发

```sh
npm run dist:linux   # bundle:dsh + 构建 deb + AppImage(自包含,零依赖)
npm run dist:mac     # bundle:dsh + 构建 Apple Silicon dmg/dir
npm run dist         # 同上,按当前平台打包(win: nsis)
```

产物在 `dist/`。`vendor/` 不进 git（体积约 210 MB），由 `scripts/bundle-dsh.mjs` 从本机 DSH 安装生成，并自动裁剪其他平台的预编译二进制（win32/darwin/musl 等）。

### 发版清单（维护者）

每次发布新版本（保证 AppImage 自动更新链路）：

1. 更新 `package.json` 版本号，跑 `npm run dist:linux`
2. 在 GitHub 创建同名 tag 的 Release（如 `v0.4.1`），上传：
   - `dist/DeepSeek Harness Desktop-<版本>.AppImage` —— 资产名必须与 `dist/latest-linux.yml` 里写的**完全一致**（点号分隔：`DeepSeek-Harness-Desktop-<版本>.AppImage`）
   - `dist/latest-linux.yml`
   - `dist/deepseek-harness-desktop_<版本>_amd64.deb`（deb 手动安装用，不参与自动更新）
3. 不要发 draft / prerelease（electron-updater 只认最新的正式 Release）

自动更新的验证开关：`DSH_DESKTOP_AUTOUPDATE_TEST=1 <旧版AppImage>`，下载完成即自动重启安装。

## 故障排查

- **错误框提示启动失败** —— 看错误框里的服务器日志；确认 vendor/dsh 存在（源码构建需先 `npm run bundle:dsh`），或设 `DSH_BIN` 指向外部 dsh
- **服务器日志** —— `~/.config/DeepSeek Harness Desktop/logs/dsh-server.log`（Linux；macOS/Windows 在对应的 userData 目录）
- **开发调试** —— `DSH_DESKTOP_DEV=1 npm start` 会保留默认菜单（可打开 DevTools）

## Roadmap

- [x] 把 DSH（含预构建前端产物）捆绑进 app 资源，做到零依赖分发（0.3.0）
- [x] 自动更新（electron-updater，GitHub Releases 源，AppImage）（0.4.0）
- [ ] 托盘图标 / 最小化到托盘、开机自启
- [ ] Windows 打包与签名验证；macOS 签名公证（mac 的 electron-updater 也待接入）
- [ ] 捆绑脚本目前按 linux-x64 裁剪，其他平台构建需相应调整

## License

[MIT](LICENSE)
