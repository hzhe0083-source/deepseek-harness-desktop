# DeepSeek Harness Desktop

DeepSeek Harness 的桌面版：下载安装包，装上即可使用，无需 Node.js。

## 下载

前往 [GitHub Releases](https://github.com/hzhe0083-source/deepseek-harness-desktop/releases) 下载对应平台的安装包：

| 平台 | 安装包 |
| --- | --- |
| macOS (Apple Silicon) | `.dmg` |
| Linux (x64) | `.AppImage` 或 `.deb` |

有 Node.js 的话也可以一条命令（自动下载并启动最新版，macOS 加 `--install` 可装进「应用程序」）：

```sh
npx deepseek-harness-desktop
```

## 安装使用

**macOS**

1. 打开下载的 `.dmg`
2. 把 **Deepseek desktop.app** 拖到「应用程序」
3. 首次打开若被拦截，在「系统设置 → 隐私与安全性」中选择「仍要打开」

**Linux**

- `.AppImage`：直接运行（如提示缺 `libfuse2`，先执行 `sudo apt install libfuse2`）
- `.deb`：双击安装，或 `sudo apt install ./deepseek-harness-desktop_*.deb`

## 更新

- macOS 与 Linux AppImage：应用内自动更新
- Linux deb：应用提示后到 Releases 下载新版手动安装
