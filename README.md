# DeepSeek Harness Desktop

Electron 桌面壳，把 **DeepSeek Harness (DSH)** 的 Web UI 包进原生窗口。安装包自带完整 DSH 运行时，目标机器不需要 Node.js，也不需要事先安装 DSH，装上即可使用。

仓库地址：<https://github.com/hzhe0083-source/deepseek-harness-desktop>

应用本身不重写 Harness 逻辑：它在本机找一个空闲的 `127.0.0.1` 端口，启动 `dsh web`，等服务真正就绪后再打开沙箱化窗口。关闭窗口时，应用也会停止对应的本地服务。

> 当前仓库是 **0.5.0 开发线**。下文描述的是本仓库已经具备的构建与更新能力，不代表 0.5.0 已经发布到 GitHub Releases。

## 平台支持

| 平台 | 架构 | 安装包 | 更新方式 |
| --- | --- | --- | --- |
| macOS | Apple Silicon (arm64) | `.dmg` + 更新用 `.zip` | 安装首个正式签名版后，应用内自动更新 |
| Linux | x64 | `.AppImage` | 应用内自动更新 |
| Linux | x64 | `.deb` | 应用提示后打开 GitHub Releases 手动更新 |
| Windows | x64 | `.exe` (NSIS) | 配置已预留，尚未作为正式镜像发布 |

macOS 应用名称为 **Deepseek desktop**。图标使用官方 Web UI 的 `FishLogo`（与侧栏 / 欢迎页同一条路径），深色底板、单层圆角，并按 Dock 与桌面图标的正常安全区留白。

## 跟随官方 Harness，无需人工盯版本

仓库里不写死某个 DSH 版本。发布流程每 6 小时读取一次官方 npm 上 `@deepseek-ai/dsh` 的 `latest`：

1. 如果官方 `latest` 与最近一次桌面版携带的 DSH 相同，不创建新版本。
2. 如果官方 `latest` 已变化，流程只解析一次，并生成带完整依赖锁和完整性信息的临时快照。
3. macOS 与 Linux 都使用这同一份快照，因此同一批发布里的 DSH 版本完全一致。
4. 两个平台仍在各自的原生环境中单独安装依赖和验证，确保 macOS、Linux 的原生模块不会混用。
5. 两个平台都成功后才创建正式 Release，避免用户下载到不完整的一批文件。

这里的“快照”只用于让一次发布可复现，并不是需要人工维护的长期版本锁。下一次定时检查仍会继续跟随官方 `latest`。

需要重发桌面壳但 DSH 没变化时，也可以在 GitHub Actions 中手动运行发布流程并选择强制发布。

## 桌面应用自更新

- **macOS**：后台检查并下载已签名的新版本，下载完成后提示安装；也可从应用菜单手动“检查更新”。
- **Linux AppImage**：后台检查并下载新 AppImage，下载完成后提示安装。
- **Linux deb**：为避免桌面应用自行调用系统包管理器，应用会打开 GitHub Releases，由用户下载并安装新的 deb。
- 开发运行、未打包版本和不支持的平台不会尝试静默替换应用。
- 后台检查失败只写入日志，不打断工作；用户手动检查时才显示明确结果。

macOS 自动更新要求新旧版本都具有可信且一致的 Developer ID 签名。因此，启用正式发布后，需要先手动下载安装一次首个签名版；从这个版本开始，后续版本即可在应用内自动更新。未签名的本地构建仅供本机测试，不能作为自动更新链条的起点。

## 特性

- **开箱即用的内置运行时** —— 安装包包含 DSH、全部生产依赖与前端产物，在 Electron 自带的 Node 运行时上执行，无需系统 Node / npm / dsh
- **跨平台共用一次解析结果** —— macOS 与 Linux 跟随同一个官方 `latest` 快照，再各自在原生环境中完成构建与验证
- **桌面自动更新** —— macOS 与 Linux AppImage 支持应用内更新；deb 安全跳转到 Releases
- **外部 dsh 仍可用** —— `DSH_BIN` 可显式指定外部 dsh；没有内置运行时的源码开发会继续尝试机器上的 dsh，最后回退到官方 npm
- **共享同一份数据** —— 会话、设置、preset、skills 全部沿用 `~/.dsh`，和浏览器方式使用的是同一份数据
- **自动端口选择** —— 不占用固定端口，和已经运行的 `dsh web` 互不冲突
- **启动就绪探测** —— 服务真正可以响应后才开窗；启动失败或异常退出会显示可读错误与日志位置
- **单实例锁** —— 重复启动时聚焦已有窗口
- **安全默认** —— `contextIsolation` + `sandbox` + 无 `nodeIntegration`，外链交给系统浏览器
- **服务生命周期** —— 关窗后先正常停止 DSH，超时才强制结束
- **macOS 适配** —— 自动带上 Homebrew PATH，并保留原生应用菜单

## 运行时解析顺序

正式安装包默认使用自身携带的 DSH；只有用户显式设置 `DSH_BIN` 时才会覆盖它。如果内置运行时缺失或损坏，应用会明确报错，不会临时联网换成另一个版本。源码开发时按以下优先级选择 DSH：

1. `DSH_BIN` 环境变量显式指定的启动器
2. 项目中的完整 `vendor/dsh` 运行时
3. 机器上已安装的 `dsh`（包括 nvm / Homebrew / pnpm / npm-global 常见位置）
4. 官方 npm 的 `@deepseek-ai/dsh@latest`（仅开发回退；首次启动较慢，因此超时时间更长）

内置运行时通过 Electron 自带的 Node 运行，不依赖目标机器的开发环境。`--expose-internals` 是 DSH 当前 HMR 服务所需的 V8 参数。

## 使用与本地构建

终端用户从 GitHub Release 下载对应平台的安装包即可。

源码开发：

```sh
npm install
npm run bundle:dsh   # 构建时自动解析官方 latest 并生成完整本机运行时
npm start
```

如果本机已有希望用于调试的 dsh，可显式指定：

```sh
DSH_BIN=/path/to/dsh npm start
```

构建安装包：

```sh
npm run dist:mac     # Apple Silicon：dmg / zip / app
npm run dist:linux   # Linux x64：deb / AppImage
npm run dist         # 按当前平台使用 electron-builder
```

产物位于 `dist/`。`vendor/` 不进入 git，而是在每次构建时生成，包含当前目标平台所需的完整生产依赖。

### macOS 本地安装

打开构建出的 dmg，把 **Deepseek desktop.app** 拖到“应用程序”；也可以直接打开未打包目录中的应用。

未签名的本地构建第一次打开若被 macOS 拦截，可在“系统设置 → 隐私与安全性”中选择“仍要打开”。这只适用于本地测试；正式自动更新必须使用签名并经过 Apple 公证的安装包。

### Linux 本地安装

`dist/` 中会生成 `.deb` 和 `.AppImage`。AppImage 可直接运行并支持应用内更新；deb 继续由系统安装器管理。

## CI 共用快照机制

发布流程先创建一次临时 DSH 快照，再把同一个目录交给 Linux 与 macOS 构建任务：

```sh
node scripts/bundle-dsh.mjs --prepare-snapshot /path/to/dsh-snapshot
DSH_SNAPSHOT_DIR=/path/to/dsh-snapshot npm run bundle:dsh
```

`--prepare-snapshot` 读取官方 `latest`，保存解析出的准确版本、npm 锁文件与完整性信息。`DSH_SNAPSHOT_DIR` 让后续构建直接使用该快照，不再各自重新解析 `latest`。CI 只在本次运行期间保存它，不需要开发者修改仓库中的版本号。

每个平台完成组装后还会用 Electron 自带的 Node 检查 CLI、Web 服务和原生依赖；任何一个平台失败，都不会创建 Release。

macOS 的运行时组装与签名分成两个隔离任务：无任何长期凭据的原生构建任务负责安装并实际运行 DSH 烟测；随后，全新的签名任务只接收已经验证过的运行时归档，不执行其中的代码，再完成应用签名、公证和安装包校验。这样即使上游依赖出现供应链问题，也接触不到 Apple 签名凭据。

## 正式发布的一次性配置

自动更新发布链默认“安全失败”：以下保护没有全部启用时，流程会停止，不会生成或上传可自动安装的版本。

1. 在 GitHub 创建名为 `production-release` 的 Environment。
2. Environment 的部署分支规则必须只允许仓库默认分支；默认分支本身也必须启用 branch protection 或 ruleset。
3. 在仓库设置中启用 **Immutable Releases**，防止发布后的安装包和更新元数据被替换。
4. 把下列值保存为 `production-release` 的 Environment secrets，而不是普通仓库文件或构建变量：

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`
- `RELEASE_ADMIN_TOKEN`（仅需读取仓库管理设置，用于验证上述门禁）

前五项用于 Developer ID 签名和 Apple 公证，只会进入全新的 macOS 签名任务；DSH 的安装、启动和烟测都在没有这些凭据的任务中完成。`RELEASE_ADMIN_TOKEN` 只用于确认默认分支、Environment 和 Immutable Releases 的状态。凭据缺失或任一保护不符合要求时，整批发布会停止，而不是上传未签名或可被替换的更新。

完成这一次性配置后，无需再手动维护 DSH 版本。定时流程会继续跟随官方 npm `latest`，只有版本或官方包完整性发生变化时才发布新的桌面版本。

## 工作原理

```text
Electron main ──spawn──> Electron 内置 Node + vendor/dsh/.../lib/bin.js
                             └ web --host 127.0.0.1 --port <空闲端口>
     │                        │
     │  轮询直到服务就绪      │
     │<───────────────────────┘
     │
BrowserWindow ──loadURL──> http://127.0.0.1:<端口>
```

DSH 服务只绑定本机地址。Electron 窗口加载本机 Web UI，外部链接则交给系统浏览器。

## 故障排查

- **提示启动失败** —— 查看错误框中的服务器日志；源码开发时确认已经运行 `npm run bundle:dsh`，或用 `DSH_BIN` 指向外部 dsh
- **自动更新没有安装** —— macOS 确认当前应用来自正式签名版；Linux 确认运行的是 AppImage，deb 会打开 Releases 手动更新
- **AppImage 报 `dlopen(): error loading libfuse.so.2`** —— 系统缺 FUSE2：`sudo apt install libfuse2`；临时可用 `<AppImage> --appimage-extract-and-run` 直接运行（自动更新的最终重启步骤同样需要 libfuse2）
- **服务器日志** —— Linux 通常位于 `~/.config/DeepSeek Harness Desktop/logs/dsh-server.log`；macOS / Windows 位于各自的应用数据目录
- **开发调试** —— `DSH_DESKTOP_DEV=1 npm start` 会保留调试菜单

## Roadmap

- [x] 安装包捆绑 DSH 完整运行时，做到终端用户零依赖
- [x] macOS / Linux 使用同一次官方 `latest` 解析结果，并在目标平台原生构建
- [x] 每 6 小时检查官方 DSH，仅在变化时准备新版本
- [x] macOS 与 Linux AppImage 应用内更新，deb 安全跳转 Releases
- [ ] 托盘图标 / 最小化到托盘、开机自启
- [ ] Windows 正式打包、签名与更新验证

## License

[MIT](LICENSE)
