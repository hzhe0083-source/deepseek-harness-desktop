# DeepSeek Harness Desktop

Electron 桌面壳,把**本地安装的 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)** 的 Web UI 包进一个原生窗口。

应用本身不重写任何 harness 逻辑:它在本机找一个空闲的 127.0.0.1 端口,启动 `dsh web`,等服务真正就绪后再把沙箱化的 `BrowserWindow` 指过去。关闭窗口即停止服务并退出。

## 特性

- **零改动复用本地 DSH** —— 会话、设置、preset、skills 全部沿用 `~/.dsh` 里的数据,和浏览器里用的是同一份
- **自动端口选择** —— 不占用固定端口,和已开着的 `dsh web`(如 3080)互不冲突
- **启动就绪探测** —— 轮询直到 SPA 真的开始响应才开窗;`dsh` 启动失败/退出会弹出带日志的错误框
- **单实例锁** —— 重复启动时聚焦已有窗口
- **安全默认** —— `contextIsolation` + `sandbox` + 无 `nodeIntegration`,外链一律交给系统浏览器
- **服务生命周期** —— 关窗 → `SIGTERM` 停止 dsh → 退出;3 秒兜底 `SIGKILL`

## 前置要求

- Node.js ≥ 20
- 本地已安装 DSH 命令行:

```sh
npm i -g @deepseek-ai/dsh
```

如果 `dsh` 不在 PATH 中(例如用 nvm 安装的),设置环境变量指向它:

```sh
DSH_BIN=/path/to/dsh npm start
```

应用也会自动探测 `~/.nvm/current/bin/dsh` 和 `~/.nvm/versions/node/*/bin/dsh`。

## 使用

```sh
npm install
npm start
```

## 工作原理

```
Electron main ──spawn──> dsh web --host 127.0.0.1 --port <free-port>
     │                        │
     │  poll GET / until 200  │
     │<───────────────────────┘
     │
BrowserWindow ──loadURL──> http://127.0.0.1:<port>
```

DSH 的服务端对 IP 字面量的 host 天然放行(无 DNS rebinding 风险),Electron 里加载 `http://127.0.0.1:<port>` 与浏览器访问完全等价。

## 打包分发

```sh
npm run dist:linux   # 生成 deb + AppImage
npm run dist         # 按当前平台打包(win: nsis, mac: dmg)
```

产物在 `dist/`。注意:打包出来的安装包仍要求目标机器上装有 `dsh` 命令行;把 DSH 运行时随包捆绑是后续路线图(见下)。

## 故障排查

- **错误框提示找不到 dsh** —— 用 `DSH_BIN` 环境变量指向 dsh 启动器,或 `npm i -g @deepseek-ai/dsh`
- **服务器日志** —— `~/.config/deepseek-harness-desktop/logs/dsh-server.log`(Linux;macOS/Windows 在对应的 userData 目录)
- **开发调试** —— `DSH_DESKTOP_DEV=1 npm start` 会保留默认菜单(可打开 DevTools)

## Roadmap

- [ ] 把 `@deepseek-ai/dsh`(含预构建前端产物)捆绑进 app 资源,做到零依赖分发
- [ ] 托盘图标 / 最小化到托盘、开机自启
- [ ] 自动更新(electron-updater)
- [ ] Windows / macOS 打包与签名验证

## License

[MIT](LICENSE)
