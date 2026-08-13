# DeepSeek Harness Desktop

## 下载与安装

需要 Node.js 18+。在终端运行：

```sh
npx deepseek-harness-desktop
```

会下载并启动最新桌面版，同时写入系统应用图标，之后可以从应用列表打开：

- macOS：挂载 dmg 并启动（加 `--install` 装进「应用程序」）
- Linux：下载 AppImage、写入 Ubuntu 应用菜单图标并启动；没有 libfuse2 时自动解包
- Windows：运行 portable 版（免安装）

npm 包只有几 KB，真正的安装包从 GitHub Releases 下载并缓存到本地。再次执行同一命令即可检查更新。
