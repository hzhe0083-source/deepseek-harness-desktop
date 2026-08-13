<p align="right"><a href="./README.md">English</a> · <strong>中文</strong></p>

# DeepSeek Harness Desktop

## 下载与安装

在终端运行：

```sh
npx deepseek-harness-desktop
```

会先检查 Node.js 18+。如果没有安装或版本过旧，先下载一份本地 LTS（不会覆盖系统 Node），再启动应用：

```sh
# macOS / Linux
curl --proto '=https' --tlsv1.2 -fsSL \
  https://raw.githubusercontent.com/hzhe0083-source/deepseek-harness-desktop/main/setup.sh | sh

# Windows（PowerShell）
irm https://raw.githubusercontent.com/hzhe0083-source/deepseek-harness-desktop/main/setup.ps1 | iex
```

`npx` 会下载并启动最新桌面版，同时写入系统应用图标，之后可以从应用列表打开：

- macOS：挂载 dmg 并启动（加 `--install` 装进「应用程序」）
- Linux：下载 AppImage、写入 Ubuntu 应用菜单图标并启动；没有 libfuse2 时自动解包
- Windows：运行 portable 版（免安装）

npm 包只有几 KB，真正的安装包从 GitHub Releases 下载并缓存到本地。再次执行同一命令即可检查更新。
