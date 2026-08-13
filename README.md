# DeepSeek Harness Desktop

Electron 桌面壳，把**本地安装的 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)** 的 Web UI 包进一个原生窗口。

仓库地址：<https://github.com/hzhe0083-source/deepseek-harness-desktop>

应用本身不重写任何 harness 逻辑：它在本机找一个空闲的 `127.0.0.1` 端口，启动 `dsh web`，等服务真正就绪后再把沙箱化的 `BrowserWindow` 指过去。关闭窗口即停止服务并退出。

## 平台镜像版本

当前应用版本：**0.2.0**

| 镜像 | 版本 | 架构 | 产物 | 状态 |
| --- | --- | --- | --- | --- |
| **Linux** | 0.1.0 起，现随 0.2.0 | x64 / 本机 | `.deb` + `.AppImage` | **已有** |
| **macOS / 苹果镜像** | **0.2.0** | **Apple Silicon (arm64)** | `.app` + `.dmg` | **本次新增** |
| Windows | — | x64 | `.exe` (NSIS) | 配置已预留，尚未作为正式镜像发布 |

- Linux 镜像：`npm run dist:linux`
- 苹果镜像：`npm run dist:mac`  
  产物名：`DeepSeek Harness Desktop-0.2.0-mac-arm64.dmg`  
  以及未打包目录：`dist/mac-arm64/DeepSeek Harness Desktop.app`

GitHub Releases 里的苹果镜像请认准 **`v0.2.0`** 和文件名里的 **`mac-arm64`**。Intel Mac 不在本镜像范围内。

图标使用 GitHub 仓库 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的官方 UI 鲸鱼标（`#4D6BFE`）。

## 特性

- **零改动复用本地 DSH** —— 会话、设置、preset、skills 全部沿用 `~/.dsh` 里的数据，和浏览器里用的是同一份
- **自动端口选择** —— 不占用固定端口，和已开着的 `dsh web`（如 3080）互不冲突
- **启动就绪探测** —— 轮询直到 SPA 真的开始响应才开窗；`dsh` 启动失败/退出会弹出带日志的错误框
- **单实例锁** —— 重复启动时聚焦已有窗口
- **安全默认** —— `contextIsolation` + `sandbox` + 无 `nodeIntegration`，外链一律交给系统浏览器
- **服务生命周期** —— 关窗 → `SIGTERM` 停止 dsh → 退出；3 秒兜底 `SIGKILL`
- **苹果镜像额外处理** —— 自动带上 Homebrew PATH（`/opt/homebrew/bin`）；找不到全局 `dsh` 时回退 `npx @deepseek-ai/dsh web`

## 前置要求

- Node.js ≥ 20（macOS 推荐 Homebrew：`brew install node`）
- 本地已安装 DSH 命令行（可选，未安装时会走 npx）：

```sh
npm i -g @deepseek-ai/dsh
```

如果 `dsh` 不在 PATH 中（例如用 nvm 安装的），设置环境变量指向它：

```sh
DSH_BIN=/path/to/dsh npm start
```

应用也会自动探测 `~/.nvm/current/bin/dsh`、`~/.nvm/versions/node/*/bin/dsh`，以及 macOS 上的 Homebrew。

## 使用

```sh
npm install
npm start
```

### 苹果镜像（macOS）

1. 从 Release `v0.2.0` 下载 `DeepSeek Harness Desktop-0.2.0-mac-arm64.dmg`，或本地构建：

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
Electron main ──spawn──> dsh web --host 127.0.0.1 --port <free-port>
     │                        │
     │  poll GET / until 200  │
     │<───────────────────────┘
     │
BrowserWindow ──loadURL──> http://127.0.0.1:<port>
```

DSH 的服务端对 IP 字面量的 host 天然放行（无 DNS rebinding 风险），Electron 里加载 `http://127.0.0.1:<port>` 与浏览器访问完全等价。

## 打包分发

```sh
npm run dist:linux   # Linux 镜像：deb + AppImage
npm run dist:mac     # 苹果镜像：arm64 dmg + .app
npm run dist         # 按当前平台打包（win: nsis, mac: dmg, linux: deb/AppImage）
```

产物在 `dist/`。注意：打包出来的安装包仍要求目标机器上能跑 `dsh`（全局安装，或本机有 `npx` + Node）。把 DSH 运行时随包捆绑是后续路线图。

## 故障排查

- **错误框提示找不到 dsh** —— 用 `DSH_BIN` 环境变量指向 dsh 启动器，或 `npm i -g @deepseek-ai/dsh`
- **macOS 找不到 node / npx** —— 确认已 `brew install node`，应用会读 `/opt/homebrew/bin`
- **服务器日志**
  - Linux：`~/.config/DeepSeek Harness Desktop/logs/dsh-server.log`
  - macOS：`~/Library/Application Support/DeepSeek Harness Desktop/logs/dsh-server.log`
- **开发调试** —— `DSH_DESKTOP_DEV=1 npm start` 会保留默认菜单（可打开 DevTools）

## Roadmap

- [x] Linux 镜像（deb / AppImage）
- [x] macOS / 苹果镜像（Apple Silicon .app / .dmg）
- [ ] 把 `@deepseek-ai/dsh`（含预构建前端产物）捆绑进 app 资源，做到零依赖分发
- [ ] 托盘图标 / 最小化到托盘、开机自启
- [ ] 自动更新（electron-updater）
- [ ] Windows 正式镜像与签名验证

## License

[MIT](LICENSE)
