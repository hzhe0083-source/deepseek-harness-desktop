<p align="right"><strong>English</strong> · <a href="./README.zh-CN.md">中文</a></p>

# DeepSeek Harness Desktop

## Download and install

In a terminal, run:

```sh
npx deepseek-harness-desktop
```

This first checks for Node.js 18+. If Node is missing or too old, download a local LTS copy (it does not replace your system Node) and start the app:

```sh
# macOS / Linux
curl --proto '=https' --tlsv1.2 -fsSL \
  https://raw.githubusercontent.com/hzhe0083-source/deepseek-harness-desktop/main/setup.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/hzhe0083-source/deepseek-harness-desktop/main/setup.ps1 | iex
```

`npx` then downloads and starts the latest desktop app, and registers a system app icon so you can open it from the application menu later:

- macOS: mounts the dmg and launches it (add `--install` to copy it into Applications)
- Linux: downloads the AppImage, writes an Ubuntu application-menu icon, and launches it; extracts automatically if libfuse2 is missing
- Windows: runs the portable build (no installer)

The npm package is only a few KB. The real app is downloaded from GitHub Releases and cached locally. Run the same command again to check for updates.

## Screenshots

| macOS | Linux |
| --- | --- |
| <img src="assets/screenshots/macos.jpg" alt="DeepSeek Harness Desktop on macOS" width="100%"> | <img src="assets/screenshots/linux.png" alt="DeepSeek Harness Desktop on Linux" width="100%"> |
