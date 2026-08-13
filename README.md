# DeepSeek Harness Desktop

DeepSeek Harness 的 Electron 桌面端。当前源码版本为 **0.5.0**：Desktop 改为瘦安装包，不再把完整 DSH 运行时塞进安装包；本机没有 `dsh` 时，首次启动才下载固定版本的运行时。

仓库：<https://github.com/hzhe0083-source/deepseek-harness-desktop>

## 下载与安装

### Linux x64：一条命令安装

```sh
curl --proto '=https' --tlsv1.2 -fsSL \
  https://raw.githubusercontent.com/hzhe0083-source/deepseek-harness-desktop/main/install.sh | sh
```

该命令从 [GitHub Releases 最新正式版](https://github.com/hzhe0083-source/deepseek-harness-desktop/releases/latest) 下载 AppImage、校验 Release 中的 SHA-512、安装到用户目录并启动。无需 `sudo`；再次执行同一命令即可更新或确认已是最新版。

也可以在 [GitHub Releases](https://github.com/hzhe0083-source/deepseek-harness-desktop/releases) 直接下载：

- `DeepSeek-Harness-Desktop-<版本>-linux-x86_64.AppImage`：加执行权限后直接运行；支持应用内自动更新。
- `DeepSeek-Harness-Desktop-<版本>-linux-amd64.deb`：用 `sudo apt install ./文件名.deb` 安装；deb 版本需要手动下载更新。

### macOS arm64（Apple Silicon）

0.5.0 Release 发布后，从 [GitHub Releases](https://github.com/hzhe0083-source/deepseek-harness-desktop/releases) 下载 `DeepSeek-Harness-Desktop-0.5.0-mac-arm64.dmg`，打开后把应用拖进“应用程序”。

**当前必须等 0.5.0 Release 中出现这个 DMG 资产，才有正式的 0.5.0 macOS 下载包。** 如果 Release 页面还没有它，可以按下方“源码开发与构建”自行构建；Intel Mac 暂无正式安装包。

### npm / npx：一条命令启动（可选）

机器上有 Node.js 18+ 的话，也可以不手动下载安装包：

```sh
npx deepseek-harness-desktop
```

自动下载并启动最新版，三平台无感：

- macOS：挂载 dmg 并启动（加 `--install` 装进「应用程序」）
- Linux：直接运行 AppImage（缺 FUSE2 时自动改用 extract-and-run）
- Windows：直接运行 portable 版（免安装）

npm 包本身只有几 KB，真正的安装包仍从 GitHub Releases 下载并缓存到本地。

### 不能用 pip 安装 Desktop

DeepSeek Harness Desktop 是 Electron 应用，**不提供 pip 包**。`pip install deepseek-harness-sdk` 安装的是供 Python 程序调用的 SDK，不是 Desktop，也不会安装桌面界面。

普通用户只需下载 AppImage、deb 或 DMG；不需要安装 Python、Node.js 或 npm。

## 瘦安装包如何工作

启动时按以下顺序选择 DSH：

1. `DSH_BIN` 指定的 `dsh`。
2. 本机已经安装、可在 PATH、nvm、Homebrew、pnpm 或 npm-global 常见位置找到的 `dsh`。
3. 已校验并缓存的受管运行时。
4. 若缓存不存在，从当前 Desktop 版本对应的 GitHub Release 下载固定的 **`@deepseek-ai/dsh@0.1.0-rc.6`** 运行时，校验 SHA-256 后缓存并启动。

因此，本机已有 DSH 时不会重复下载；本机没有 DSH 时只在首次启动联网下载一次，之后可直接使用缓存。升级到绑定了不同 DSH 版本的 Desktop 时，会为新版本建立独立缓存。

默认缓存位置：

- Linux：`~/.config/DeepSeek Harness Desktop/runtime/0.1.0-rc.6/<平台-架构>/`
- macOS：`~/Library/Application Support/DeepSeek Harness Desktop/runtime/0.1.0-rc.6/darwin-arm64/`

如果首次下载失败，请检查网络能否访问 GitHub Releases 后重启应用。需要强制使用本机安装时，可从终端启动：

```sh
DSH_BIN=/absolute/path/to/dsh deepseek-harness-desktop
```

`DSH_RUNTIME_URL` 与 `DSH_RUNTIME_SHA256` 仅用于镜像、测试或维护，不是普通安装所必需。

## 支持范围

| 用途 | 平台 / 架构 | 状态 |
| --- | --- | --- |
| 正式 Desktop 安装包 | Linux x64、glibc 2.35+（Ubuntu 22.04+） | AppImage + deb |
| 正式 Desktop 安装包 | macOS arm64 | 0.5.0 DMG 发布后可用 |
| 受管 DSH 运行时 | Linux x64、Linux arm64、macOS arm64 | 各平台原生构建的独立资产 |
| Windows / Intel Mac | — | 暂无正式安装包；不会自动下载受管运行时 |

在不支持受管下载的平台上，如果自行构建 Desktop，仍可通过 `DSH_BIN` 或本机安装的 `dsh` 运行。

## 主要特性

- Desktop 安装包只包含桌面壳；DSH 运行时按需下载并复用缓存。
- 会话、设置、preset 和 skills 继续使用 `~/.dsh`，与浏览器方式共享数据。
- 自动选择空闲的 `127.0.0.1` 端口，等 Web UI 就绪后再显示窗口。
- 单实例运行；关闭窗口时终止它启动的 DSH 服务。
- `contextIsolation`、sandbox、无 `nodeIntegration`；外链由系统浏览器打开。

AppImage 启动后会通过 GitHub Releases 检查 Desktop 更新；下载完成后可以立即重启安装或退出时安装。deb 与 DMG 不走这条自更新链路。

## 源码开发与构建

源码开发需要 Node.js 和 npm；这些依赖只面向开发者，不要求终端用户安装。

```sh
npm ci
npm test
npm start
```

构建瘦 Desktop 安装包：

```sh
npm run dist:linux   # Linux x64：deb + AppImage
npm run dist:win     # Windows x64：NSIS（瘦 Desktop，未签名）
npm run dist:mac     # macOS arm64：dmg + 未打包 app
```

Windows CI 位于 `.github/workflows/windows-build.yml`，在 `windows-latest` 上运行测试并生成未签名的 NSIS artifact；Windows 当前没有正式 Release，也不下载受管 DSH 运行时。

构建当前原生平台的独立运行时资产：

```sh
npm run build:runtime
```

运行时包含原生依赖，必须在目标平台/架构上构建，不能用一台 x64 Linux 机器代替 Linux arm64 或 macOS arm64。产物写入 `dist/runtime/`，包括 `.tar.gz` 与对应的 `.sha256`。

当前 Release DMG 与本地构建的 macOS 应用都尚未签名、公证。首次打开可能被 Gatekeeper 拦截；请在 Finder 中右键应用选择“打开”，或前往“系统设置 → 隐私与安全性 → 仍要打开”。

## 发版资产与清单

0.5.0 Release 必须同时提供 Desktop 和它会请求的固定运行时；Desktop 默认从同名版本 Release（例如 `v0.5.0`）取运行时。

1. 确认 `package.json` 为 `0.5.0`，`deepseekHarness.runtimeVersion` 与 `runtime/package.json` 都固定为 `0.1.0-rc.6`，tag 使用完全对应的 `v0.5.0`。
2. 上传 Linux x64 的 AppImage、deb 与 `latest-linux.yml`，以及 macOS arm64 的 `DeepSeek-Harness-Desktop-0.5.0-mac-arm64.dmg`。
3. 在各自原生 runner 构建并上传 `dsh-runtime-0.1.0-rc.6-{linux-x64,linux-arm64,darwin-arm64}.tar.gz`。
4. 为每个运行时压缩包上传同名 `.sha256`；资产名不要改动，否则 Desktop 无法按约定 URL 下载。
5. 发布为正式、非 draft 的 Release，并在干净机器上验证首次下载、第二次缓存启动、离线启动和 AppImage 更新。

## 工作原理

```text
Electron main
  └─ 解析 DSH_BIN / 本机 dsh / 受管缓存
       └─ 必要时下载并校验固定版本运行时
            └─ dsh web --host 127.0.0.1 --port <空闲端口>
                 └─ 就绪后 BrowserWindow 加载本地 Web UI
```

服务器日志位于 Electron 的 userData 日志目录；Linux 默认是 `~/.config/DeepSeek Harness Desktop/logs/dsh-server.log`。开发时可用 `DSH_DESKTOP_DEV=1 npm start` 保留默认菜单和 DevTools 入口。

## License

[MIT](LICENSE)
