# DeepSeek Harness Desktop

Electron 桌面壳,把 **DeepSeek Harness (DSH)** 的 Web UI 包进一个原生窗口,**安装包自带完整 DSH 运行时,目标机器不需要 Node.js、也不需要装过 DSH,装上就能用**。

应用本身不重写任何 harness 逻辑:它在本机找一个空闲的 127.0.0.1 端口,启动内置的 `dsh web`,等服务真正就绪后再把沙箱化的 `BrowserWindow` 指过去。关闭窗口即停止服务并退出。

## 特性

- **开箱即用的内置运行时** —— 随包分发完整 DSH(vendor/dsh,含全部依赖与前端产物),在 **Electron 自带的 Node 运行时**上执行(`ELECTRON_RUN_AS_NODE=1`),无需系统 Node / npm / dsh
- **外部 dsh 仍可用** —— 设 `DSH_BIN` 可强制指向外部安装的 dsh;不带 vendor 的源码开发构建则自动回退到 PATH 里的 `dsh`
- **共享同一份数据** —— 会话、设置、preset、skills 全部沿用 `~/.dsh`,和浏览器里用的是同一份
- **自动端口选择** —— 不占用固定端口,和已开着的 `dsh web`(如 3080)互不冲突
- **启动就绪探测** —— 轮询直到 SPA 真的开始响应才开窗;启动失败/意外退出会弹出带日志的错误框
- **单实例锁** —— 重复启动时聚焦已有窗口
- **安全默认** —— `contextIsolation` + `sandbox` + 无 `nodeIntegration`,外链一律交给系统浏览器
- **服务生命周期** —— 关窗 → `SIGTERM` 停止 dsh → 退出;3 秒兜底 `SIGKILL`

## 使用

**终端用户**:安装 `dist/` 里的 deb 或 AppImage,直接启动。

**源码开发/构建**:

```sh
npm install
npm run bundle:dsh   # 把本机(或 DSH_INSTALL_DIR 指向的)DSH 安装复制进 vendor/dsh
npm start            # 开发运行(无 vendor 时自动回退到 PATH 里的 dsh)
```

## 运行时解析顺序

启动时按以下优先级选择如何运行 dsh:

1. `DSH_BIN` 环境变量(显式指定的外部 dsh 启动器)
2. 内置 `vendor/dsh`(打包版在 `resources/vendor/dsh`),用 `process.execPath` + `--expose-internals` + `ELECTRON_RUN_AS_NODE=1` 在 Electron 的嵌入式 Node 上运行
3. PATH 里的 `dsh`(源码开发时的便利回退)

`--expose-internals` 是 DSH 的 HMR 服务所要求的 V8 标志;DSH 自带的 `node-addon-require-builtin` 兜底在 Electron 的 Node 下不可用,因此显式传入。

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

DSH 的服务端对 IP 字面量的 host 天然放行(无 DNS rebinding 风险),Electron 里加载 `http://127.0.0.1:<port>` 与浏览器访问完全等价。

## 打包分发

```sh
npm run dist:linux   # bundle:dsh + 构建 deb + AppImage(自包含,零依赖)
npm run dist         # 同上,按当前平台打包(win: nsis, mac: dmg)
```

产物在 `dist/`。`vendor/` 不进 git(体积约 210 MB),由 `scripts/bundle-dsh.mjs` 从本机 DSH 安装生成,并自动裁剪其他平台的预编译二进制(win32/darwin/musl 等)。

## 故障排查

- **错误框提示启动失败** —— 看错误框里的服务器日志;确认 vendor/dsh 存在(源码构建需先 `npm run bundle:dsh`),或设 `DSH_BIN` 指向外部 dsh
- **服务器日志** —— `~/.config/DeepSeek Harness Desktop/logs/dsh-server.log`(Linux;macOS/Windows 在对应的 userData 目录)
- **开发调试** —— `DSH_DESKTOP_DEV=1 npm start` 会保留默认菜单(可打开 DevTools)

## Roadmap

- [x] 把 DSH(含预构建前端产物)捆绑进 app 资源,做到零依赖分发
- [ ] 托盘图标 / 最小化到托盘、开机自启
- [ ] 自动更新(electron-updater)
- [ ] Windows / macOS 打包与签名验证(捆绑脚本目前按 linux-x64 裁剪,其他平台需相应调整)

## License

[MIT](LICENSE)
