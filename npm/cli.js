#!/usr/bin/env node
// DeepSeek Harness Desktop — npm 启动器（零依赖，Node >= 18）。
//
// 工作方式：
//   1. 查询 GitHub Releases 最新版本
//   2. 按当前平台选择安装包（macOS: zip / dmg；Linux: AppImage / deb；Windows: exe）
//   3. 下载到本地缓存（已是最新则直接复用）
//   4. 启动桌面应用
//
// 这是桌面壳的引流入口：npm 包本身只有几 KB，真正的应用仍从
// GitHub Releases 下载，签名与自动更新链路不受影响。

import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'

const REPO = 'hzhe0083-source/deepseek-harness-desktop'
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`
const USER_AGENT = 'deepseek-harness-desktop-launcher'

// 仅用于测试：DSH_LAUNCHER_PLATFORM=linux node cli.js --check
const PLATFORM = process.env.DSH_LAUNCHER_PLATFORM || process.platform
const ARCH = process.env.DSH_LAUNCHER_ARCH || process.arch
// 仅用于测试：DSH_LAUNCHER_CACHE=/tmp/x 覆盖缓存目录
const CACHE_OVERRIDE = process.env.DSH_LAUNCHER_CACHE

const USAGE = `DeepSeek Harness Desktop 启动器

用法:
  deepseek-harness-desktop [选项]

选项:
  --install             macOS: 安装到「应用程序」后再启动（默认仅解压到缓存运行）
  --deb                 Linux: 下载 deb 而非 AppImage（下载后提示安装命令）
  --extract-and-run     Linux: AppImage 用 --appimage-extract-and-run 运行（FUSE 缺失时用）
  --offline             不检查更新，直接用已缓存的版本
  --force               忽略缓存，强制重新下载
  --check               只检查最新版本与本机缓存，不下载、不启动
  --help                显示本帮助
`

function fail (message) {
  console.error(`\n✖ ${message}`)
  process.exit(1)
}

function cacheDir () {
  if (CACHE_OVERRIDE) return CACHE_OVERRIDE
  if (PLATFORM === 'darwin') return join(homedir(), 'Library', 'Caches', 'deepseek-harness-desktop')
  if (PLATFORM === 'win32') return join(process.env.LOCALAPPDATA || homedir(), 'deepseek-harness-desktop')
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'deepseek-harness-desktop')
}

async function fetchLatestRelease () {
  let response
  try {
    response = await fetch(API_URL, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' }
    })
  } catch {
    fail(`无法连接 GitHub API（${API_URL}）。请检查网络后重试。`)
  }
  if (response.status === 403 || response.status === 429) {
    fail('GitHub API 限流（未认证的 IP 每小时 60 次）。稍后再试，或直接到 GitHub Releases 下载安装包。')
  }
  if (response.status === 404) {
    fail('仓库还没有发布任何 Release。请先到 GitHub 仓库查看发布状态。')
  }
  if (!response.ok) {
    fail(`GitHub API 返回 ${response.status}。请稍后重试。`)
  }
  return response.json()
}

function pickAsset (release) {
  const assets = (release.assets || []).filter((a) => !a.name.endsWith('.zip.blockmap'))
  const names = assets.map((a) => a.name)

  if (PLATFORM === 'darwin') {
    if (ARCH !== 'arm64') fail(`暂不支持 macOS ${ARCH}，请使用 Apple Silicon 机器或直接到 Releases 下载安装包。`)
    const zip = assets.find((a) => a.name.endsWith('.zip') && a.name.includes('mac'))
    if (zip) return zip
    const dmg = assets.find((a) => a.name.endsWith('.dmg') && a.name.includes('mac'))
    if (dmg) return dmg
    fail(`最新版本 ${release.tag_name} 还没有 macOS 安装包（现有资产：${names.join(', ') || '无'}）。`)
  }

  if (PLATFORM === 'linux') {
    if (ARCH !== 'x64') fail(`暂不支持 Linux ${ARCH}，请使用 x64 机器或直接到 Releases 下载安装包。`)
    if (process.argv.includes('--deb')) {
      const deb = assets.find((a) => a.name.endsWith('.deb'))
      if (deb) return deb
      fail(`最新版本 ${release.tag_name} 还没有 deb 安装包。`)
    }
    const appimage = assets.find((a) => a.name.endsWith('.AppImage'))
    if (appimage) return appimage
    fail(`最新版本 ${release.tag_name} 还没有 AppImage（现有资产：${names.join(', ') || '无'}）。`)
  }

  if (PLATFORM === 'win32') {
    // 优先免安装的 portable 版本；没有 portable 时退回 NSIS 安装向导
    const portable = assets.find((a) => a.name.endsWith('.exe') && /portable/i.test(a.name))
    if (portable) return portable
    const exe = assets.find((a) => a.name.endsWith('.exe'))
    if (exe) return exe
    fail(`最新版本 ${release.tag_name} 还没有 Windows 安装包。`)
  }

  fail(`不支持当前平台 ${PLATFORM}。请到 GitHub Releases 手动下载。`)
}

function formatBytes (bytes) {
  if (!Number.isFinite(bytes)) return '未知大小'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

async function download (asset, dest) {
  const response = await fetch(asset.browser_download_url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/octet-stream' }
  })
  if (!response.ok || !response.body) fail(`下载失败（HTTP ${response.status}）。`)

  const total = Number(response.headers.get('content-length') || asset.size || 0)
  console.log(`下载 ${asset.name}（${formatBytes(total)}）…`)

  const tmp = `${dest}.part`
  await pipeline(response.body, createWriteStream(tmp))

  const actual = statSync(tmp).size
  if (Number.isFinite(asset.size) && actual !== asset.size) {
    rmSync(tmp, { force: true })
    fail(`下载不完整（期望 ${asset.size} 字节，实际 ${actual} 字节）。请重试或加 --force。`)
  }
  renameSync(tmp, dest)
  console.log(`✓ 已保存 ${dest}`)
  return actual
}

function spawnDetached (command, args = [], options = {}) {
  const child = spawn(command, args, { detached: true, stdio: 'ignore', ...options })
  child.on('error', (error) => {
    console.error(`✖ 启动失败（${command}）：${error.message}`)
    process.exit(1)
  })
  child.unref()
  return child
}

function launchMacApp (appPath) {
  const appName = basename(appPath)
  if (process.argv.includes('--install')) {
    const installed = join('/Applications', appName)
    console.log('安装到 /Applications …')
    const result = spawnSync('ditto', [appPath, installed], { stdio: 'inherit' })
    if (result.status === 0) {
      console.log(`✓ 已安装：${installed}`)
      spawnDetached('open', [installed])
      return
    }
    console.error(`安装失败（退出码 ${result.status}），改为直接运行已解压的应用。`)
  }
  spawnDetached('open', [appPath])
  console.log(`✓ 已启动 ${appName}`)
}

function extractMacZip (zipPath, releaseTag) {
  const versionDir = join(cacheDir(), `app-${releaseTag}`)
  rmSync(versionDir, { recursive: true, force: true })
  mkdirSync(versionDir, { recursive: true })
  console.log('解压 macOS 安装包…')
  const result = spawnSync('ditto', ['-x', '-k', zipPath, versionDir], { stdio: 'ignore' })
  if (result.status !== 0) fail('解压失败。请重试，或到 GitHub Releases 下载 dmg 手动安装。')
  return versionDir
}

function findAppBundle (dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.endsWith('.app')) return join(dir, entry.name)
  }
  return null
}

function installFromDmg (dmgPath, releaseTag) {
  const mountPoint = join(cacheDir(), 'mount')
  rmSync(mountPoint, { recursive: true, force: true })
  mkdirSync(mountPoint, { recursive: true })
  console.log('挂载 dmg …')
  const attach = spawnSync('hdiutil', ['attach', dmgPath, '-nobrowse', '-readonly', '-mountpoint', mountPoint], { stdio: 'ignore' })
  if (attach.status !== 0) fail('挂载 dmg 失败。请到 GitHub Releases 手动下载安装。')
  try {
    const app = findAppBundle(mountPoint)
    if (!app) fail('dmg 中没有找到 .app。请到 GitHub Releases 手动下载安装。')
    const targetDir = join(cacheDir(), `app-${releaseTag}`)
    rmSync(targetDir, { recursive: true, force: true })
    mkdirSync(targetDir, { recursive: true })
    const target = join(targetDir, basename(app))
    console.log('从 dmg 复制应用…')
    const copy = spawnSync('ditto', [app, target], { stdio: 'ignore' })
    if (copy.status !== 0) fail('从 dmg 复制应用失败。请到 GitHub Releases 手动下载安装。')
    return target
  } finally {
    spawnSync('hdiutil', ['detach', mountPoint], { stdio: 'ignore' })
  }
}

function hasFuse2 () {
  // AppImage 正常模式需要 FUSE2（libfuse.so.2）；Ubuntu 22.04+ 默认不装。
  const probe = spawnSync('ldconfig', ['-p'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  return probe.status !== 0 || /libfuse\.so\.2\b/.test(probe.stdout || '')
}

function quoteSh (value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function isPng (file) {
  try {
    const bytes = readFileSync(file)
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  } catch {
    return false
  }
}

async function installLinuxDesktop (appimage) {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  const binHome = process.env.XDG_BIN_HOME || join(homedir(), '.local', 'bin')
  const appDir = join(dataHome, 'deepseek-harness-desktop')
  const launcher = join(binHome, 'deepseek-harness-desktop')
  const desktop = join(dataHome, 'applications', 'deepseek-harness-desktop.desktop')
  const icon = join(appDir, 'deepseek-harness-desktop.png')
  const log = join(appDir, 'launch.log')
  mkdirSync(appDir, { recursive: true })
  mkdirSync(binHome, { recursive: true })
  mkdirSync(dirname(desktop), { recursive: true })

  writeFileSync(launcher, `#!/bin/sh
# deepseek-harness-desktop launcher
appimage=${quoteSh(appimage)}
log=${quoteSh(log)}
mkdir -p "$(dirname "$log")"
if [ -z "\${APPIMAGE_EXTRACT_AND_RUN:-}" ] &&
   [ ! -e /lib/x86_64-linux-gnu/libfuse.so.2 ] &&
   [ ! -e /usr/lib/x86_64-linux-gnu/libfuse.so.2 ] &&
   [ ! -e /lib64/libfuse.so.2 ] &&
   ! ldconfig -p 2>/dev/null | grep -q 'libfuse\\.so\\.2 '; then
  APPIMAGE_EXTRACT_AND_RUN=1
  export APPIMAGE_EXTRACT_AND_RUN
fi
echo "\$(date -Iseconds) exec appimage \$appimage" >>"\$log"
exec "$appimage" >>"$log" 2>&1
`, { mode: 0o755 })

  if (!isPng(icon)) {
    const tmp = `${icon}.part`
    try {
      const response = await fetch(`https://raw.githubusercontent.com/${REPO}/main/assets/icon.png`, {
        headers: { 'User-Agent': USER_AGENT }
      })
      if (response.ok && response.body) {
        await pipeline(response.body, createWriteStream(tmp))
        if (isPng(tmp)) renameSync(tmp, icon)
        else rmSync(tmp, { force: true })
      }
    } catch {
      rmSync(tmp, { force: true })
    }
  }

  const iconKey = isPng(icon) ? icon : 'deepseek-harness-desktop'
  const execKey = /^[/0-9A-Za-z._-]+$/.test(launcher) ? launcher : `"${launcher}"`
  writeFileSync(desktop, `[Desktop Entry]
Name=DeepSeek Harness Desktop
Comment=Desktop shell for the local DeepSeek Harness
Exec=${execKey}
TryExec=${launcher}
Icon=${iconKey}
Terminal=false
Type=Application
Categories=Development;
StartupWMClass=deepseek-harness-desktop
StartupNotify=false
Keywords=DeepSeek;DSH;Harness;
`)
  spawnSync('update-desktop-database', [join(dataHome, 'applications')], { stdio: 'ignore' })
  console.log(`✓ 已写入 Ubuntu 应用图标：${desktop}`)
  return launcher
}

function launchLinux (file) {
  try {
    chmodSync(file, 0o755)
  } catch {
    fail(`无法给 ${file} 添加可执行权限。`)
  }
  const env = { ...process.env }
  if (process.argv.includes('--extract-and-run') || !hasFuse2()) {
    env.APPIMAGE_EXTRACT_AND_RUN = '1'
    console.log('未检测到 libfuse2，自动改用 extract-and-run 方式启动…')
  }
  console.log('启动 AppImage…（若报 libfuse.so.2 缺失：sudo apt install libfuse2）')
  spawnDetached(file, [], { env })
}

function launchWindows (exePath) {
  const portable = /portable/i.test(exePath)
  console.log(portable
    ? '启动 Windows portable 版…'
    : '运行 Windows 安装向导…（安装完成后从开始菜单或桌面启动）')
  // Hide the console flash for portable; the NSIS wizard must stay visible.
  spawnDetached(exePath, [], { windowsHide: portable })
}

function cachedInfo () {
  const file = join(cacheDir(), 'release.json')
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function checkMode (release, asset) {
  const cached = cachedInfo()
  console.log('DeepSeek Harness Desktop 启动器')
  console.log(`  当前平台: ${PLATFORM} ${ARCH}`)
  console.log(`  最新版本: ${release.tag_name}（${release.name || release.tag_name}）`)
  console.log(`  本机资产: ${asset.name}（${formatBytes(asset.size)}）`)
  if (cached) {
    console.log(`  本地缓存: ${cached.tag}（${cached.asset}）`)
    console.log(cached.tag === release.tag_name ? '  状态: 已是最新 ✓' : `  状态: 有新版，下次运行将自动下载 ${release.tag_name}`)
  } else {
    console.log('  本地缓存: 无（首次运行将下载）')
  }
}

async function main () {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE)
    process.exit(0)
  }
  if (args.includes('--version') || args.includes('-v')) {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    console.log(pkg.version)
    process.exit(0)
  }

  const dir = cacheDir()
  mkdirSync(dir, { recursive: true })

  let release
  let asset
  if (args.includes('--offline')) {
    const cached = cachedInfo()
    if (!cached) fail('本地没有缓存，无法离线启动。请先联网运行一次。')
    release = { tag_name: cached.tag, name: cached.tag, assets: [] }
    asset = { name: cached.asset, size: null, browser_download_url: null }
  } else {
    console.log('检查最新版本…')
    release = await fetchLatestRelease()
    asset = pickAsset(release)
  }

  if (args.includes('--check')) {
    checkMode(release, asset)
    process.exit(0)
  }

  const cached = cachedInfo()
  const file = join(dir, asset.name)
  const upToDate = cached && cached.tag === release.tag_name && existsSync(file) && !args.includes('--force')

  if (upToDate) {
    console.log(`✓ 已是最新版本 ${release.tag_name}，使用本地缓存。`)
  } else {
    if (args.includes('--offline')) fail('缓存与当前版本不一致且处于离线模式。请先联网运行一次。')
    await download(asset, file)
    writeFileSync(join(dir, 'release.json'), JSON.stringify({ tag: release.tag_name, asset: asset.name }, null, 2))
  }

  if (PLATFORM === 'darwin') {
    let app
    if (asset.name.endsWith('.dmg')) {
      app = installFromDmg(file, release.tag_name)
    } else {
      const versionDir = extractMacZip(file, release.tag_name)
      app = findAppBundle(versionDir)
      if (!app) fail(`解压后没找到 .app（${versionDir}）。请到 GitHub Releases 下载 dmg 手动安装。`)
    }
    launchMacApp(app)
  } else if (PLATFORM === 'linux') {
    if (process.argv.includes('--deb')) {
      console.log(`✓ deb 已下载：${file}`)
      console.log(`安装：sudo apt install "${file}"`)
      process.exit(0)
    }
    try {
      const launcher = await installLinuxDesktop(file)
      console.log('启动桌面应用…')
      spawnDetached(launcher)
    } catch (error) {
      console.error(`写入应用图标失败：${error && error.message ? error.message : error}，改为直接启动 AppImage。`)
      launchLinux(file)
    }
  } else if (PLATFORM === 'win32') {
    launchWindows(file)
  }

  console.log('完成。本启动器可随时重复运行，每次都会检查最新版本。')
}

main().catch((error) => fail(error && error.message ? error.message : String(error)))
