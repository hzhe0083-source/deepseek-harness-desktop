<p align="right"><strong>English</strong> · <a href="./README.zh-CN.md">中文</a></p>

# DeepSeek Harness Desktop

## Download and install

Requires Node.js 18+. In a terminal, run:

```sh
npx deepseek-harness-desktop
```

This downloads and starts the latest desktop app, and also registers a system app icon so you can open it from the application menu later:

- macOS: mounts the dmg and launches it (add `--install` to copy it into Applications)
- Linux: downloads the AppImage, writes an Ubuntu application-menu icon, and launches it; extracts automatically if libfuse2 is missing
- Windows: runs the portable build (no installer)

The npm package is only a few KB. The real app is downloaded from GitHub Releases and cached locally. Run the same command again to check for updates.
