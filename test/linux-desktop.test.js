'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const root = path.join(__dirname, '..')
const installScript = path.join(root, 'install.sh')
const packageJson = require('../package.json')
const LINUX_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]

function pngSize (file) {
  const buf = fs.readFileSync(file)
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

test('electron-builder ships a multi-size Linux icon set', () => {
  assert.equal(packageJson.build.linux.icon, 'assets/linux-icons')
  assert.equal(packageJson.desktopName, 'deepseek-harness-desktop.desktop')
  assert.equal(packageJson.build.linux.syncDesktopName, true)
  assert.equal(packageJson.build.linux.desktop.entry.StartupWMClass, 'deepseek-harness-desktop')

  for (const size of LINUX_ICON_SIZES) {
    const file = path.join(root, 'assets', 'linux-icons', `${size}x${size}.png`)
    assert.equal(fs.existsSync(file), true, `missing ${file}`)
    const { width, height } = pngSize(file)
    assert.equal(width, size)
    assert.equal(height, size)
  }
})

test('install.sh writes a Ubuntu application launcher with an icon path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-'))
  try {
    const appimage = path.join(dir, 'DeepSeek-Harness-Desktop.AppImage')
    const icon = path.join(dir, 'deepseek-harness-desktop.png')
    const desktop = path.join(dir, 'applications', 'deepseek-harness-desktop.desktop')
    fs.copyFileSync(path.join(root, 'assets', 'icon.png'), icon)
    fs.writeFileSync(appimage, 'fake-appimage')

    const result = spawnSync('sh', [installScript, '--write-desktop-entry', appimage, icon, desktop], {
      encoding: 'utf8'
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const body = fs.readFileSync(desktop, 'utf8')
    assert.match(body, /^\[Desktop Entry\]$/m)
    assert.match(body, /^Name=DeepSeek Harness Desktop$/m)
    assert.match(body, /^Type=Application$/m)
    assert.match(body, /^Categories=Development;$/m)
    assert.match(body, /^StartupWMClass=deepseek-harness-desktop$/m)
    assert.match(body, new RegExp(`^Exec=${appimage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'))
    assert.match(body, /^StartupNotify=false$/m)
    assert.match(body, new RegExp(`^Icon=${icon.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'))
    assert.match(body, new RegExp(`^TryExec=${appimage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('install.sh writes a wrapper that extract-and-runs AppImages without fuse2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-launcher-'))
  try {
    const appimage = path.join(dir, 'DeepSeek-Harness-Desktop.AppImage')
    const launcher = path.join(dir, 'bin', 'deepseek-harness-desktop')
    const log = path.join(dir, 'launch.log')
    const extracted = path.join(dir, 'squashfs-root', 'AppRun')
    fs.writeFileSync(appimage, 'fake-appimage')

    const result = spawnSync('sh', [installScript, '--write-launcher', appimage, launcher, log, extracted], {
      encoding: 'utf8'
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const body = fs.readFileSync(launcher, 'utf8')
    assert.match(body, /^# deepseek-harness-desktop launcher$/m)
    assert.match(body, /APPIMAGE_EXTRACT_AND_RUN=1/)
    assert.match(body, /libfuse\.so\.2/)
    assert.match(body, /--no-sandbox/)
    assert.equal(fs.statSync(launcher).mode & 0o111, 0o111)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('install.sh still writes a launcher if the icon file is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-'))
  try {
    const appimage = path.join(dir, 'app.AppImage')
    const desktop = path.join(dir, 'app.desktop')
    fs.writeFileSync(appimage, 'fake-appimage')

    const result = spawnSync('sh', [installScript, '--write-desktop-entry', appimage, path.join(dir, 'missing.png'), desktop], {
      encoding: 'utf8'
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const body = fs.readFileSync(desktop, 'utf8')
    assert.match(body, /^Icon=deepseek-harness-desktop$/m)
    assert.match(body, /^StartupWMClass=deepseek-harness-desktop$/m)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
