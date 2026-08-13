'use strict'

// DeepSeek Harness Desktop — Electron shell for DeepSeek Harness (DSH).
//
// The app does not reimplement any harness logic. By default it runs the
// DSH copy bundled in vendor/dsh on Electron's own embedded Node runtime
// (ELECTRON_RUN_AS_NODE=1), so a packaged install needs neither Node.js nor
// a dsh install on the target machine. An explicit DSH_BIN always wins;
// otherwise it falls back to a machine-installed dsh (nvm / Homebrew /
// npm-global) and finally to `npx @deepseek-ai/dsh`.
//
// Startup: pick a free loopback port -> start dsh web -> poll until the SPA
// is served -> point a sandboxed BrowserWindow at it. Closing the window
// stops the server and quits the app.

const { app, BrowserWindow, Menu, shell, dialog } = require('electron')
const { autoUpdater } = require('electron-updater')
const { spawn } = require('node:child_process')
const net = require('node:net')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')

const DSH_HOST = '127.0.0.1'
const READY_POLL_MS = 250
const MAX_PORT_ATTEMPTS = 3

let serverProc = null
let serverPort = null
let serverUrl = null
let mainWindow = null
let quitting = false
let logStream = null
let logPath = null
let serverLogTail = []
let launchLabel = 'dsh'

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function findFreePort () {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.unref()
    probe.once('error', reject)
    probe.listen(0, DSH_HOST, () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

function appendLog (chunk) {
  const text = chunk.toString('utf8')
  if (logStream) logStream.write(text)
  serverLogTail.push(text)
  if (serverLogTail.length > 40) serverLogTail.shift()
}

function ensureLogStream () {
  if (logStream) return
  const dir = path.join(app.getPath('userData'), 'logs')
  fs.mkdirSync(dir, { recursive: true })
  logPath = path.join(dir, 'dsh-server.log')
  logStream = fs.createWriteStream(logPath, { flags: 'a' })
}

function osHome () {
  return process.env.HOME || process.env.USERPROFILE || ''
}

function extraPathDirs () {
  const home = osHome()
  const dirs = []
  if (process.platform === 'darwin') {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin')
  }
  if (process.env.NVM_BIN) dirs.push(process.env.NVM_BIN)
  dirs.push(
    path.join(home, '.nvm', 'current', 'bin'),
    path.join(home, 'Library', 'pnpm'),
    path.join(home, '.local', 'share', 'pnpm'),
    path.join(home, '.npm-global', 'bin')
  )
  return dirs
}

function prependExtraPath () {
  const extras = extraPathDirs().filter(Boolean).join(path.delimiter)
  process.env.PATH = `${extras}${path.delimiter}${process.env.PATH || '/usr/bin:/bin'}`
}

function which (name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // keep looking
    }
  }
  return null
}

function expandGlob (pattern) {
  if (!pattern.includes('*')) return [pattern]
  const star = pattern.indexOf('*')
  const prefix = pattern.slice(0, star)
  const suffix = pattern.slice(star + 1)
  const base = prefix.slice(0, prefix.lastIndexOf('/') + 1)
  const namePrefix = prefix.slice(prefix.lastIndexOf('/') + 1)
  let dir
  try {
    dir = fs.readdirSync(base)
  } catch {
    return []
  }
  return dir
    .filter((entry) => entry.startsWith(namePrefix))
    .map((entry) => base + entry + suffix)
}

function findInstalledDsh () {
  const candidates = [
    ...(process.env.NVM_BIN ? [path.join(process.env.NVM_BIN, 'dsh')] : []),
    path.join(osHome(), '.nvm', 'current', 'bin', 'dsh'),
    path.join(osHome(), '.nvm', 'versions', 'node', '*', 'bin', 'dsh'),
    path.join(osHome(), 'Desktop', 'deepseek-harness', 'node_modules', '.bin', 'dsh')
  ]
  for (const candidate of candidates) {
    for (const resolved of expandGlob(candidate)) {
      try {
        fs.accessSync(resolved, fs.constants.X_OK)
        return resolved
      } catch {
        // keep looking
      }
    }
  }
  return which('dsh')
}

// Path to the bundled dsh entry script, if the bundle is present.
function bundledDshBin () {
  const root = app.isPackaged ? process.resourcesPath : app.getAppPath()
  const bin = path.join(root, 'vendor', 'dsh', 'lib', 'bin.js')
  try {
    fs.accessSync(bin, fs.constants.R_OK)
    return bin
  } catch {
    return null
  }
}

// Resolve how to launch the harness, in priority order:
//   1. DSH_BIN — an explicit external dsh launcher the user pointed at.
//   2. Bundled vendor/dsh on Electron's embedded Node (zero-dependency mode).
//   3. A machine-installed `dsh` (nvm / Homebrew / pnpm / npm-global).
//   4. `npx --yes @deepseek-ai/dsh` (machines without a global install;
//      slower first start, so it gets a longer startup timeout).
function resolveDshLaunch (port) {
  const webArgs = ['web', '--host', DSH_HOST, '--port', String(port)]
  if (process.env.DSH_BIN) {
    return {
      command: process.env.DSH_BIN,
      args: webArgs,
      label: `external DSH_BIN (${process.env.DSH_BIN})`,
      viaNpx: false
    }
  }
  const bundledBin = bundledDshBin()
  if (bundledBin) {
    return {
      command: process.execPath,
      args: ['--expose-internals', bundledBin, ...webArgs],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      label: `bundled dsh on Electron's embedded Node ${process.versions.node}`,
      viaNpx: false
    }
  }
  const installed = findInstalledDsh()
  if (installed) {
    return { command: installed, args: webArgs, label: installed, viaNpx: false }
  }
  const npx = which('npx')
  if (npx) {
    return {
      command: npx,
      args: ['--yes', '@deepseek-ai/dsh', ...webArgs],
      label: 'npx @deepseek-ai/dsh',
      viaNpx: true
    }
  }
  return { command: 'dsh', args: webArgs, label: 'dsh', viaNpx: false }
}

function startupTimeoutMs (viaNpx) {
  if (process.env.DSH_STARTUP_TIMEOUT_MS) return Number(process.env.DSH_STARTUP_TIMEOUT_MS)
  return viaNpx ? 180_000 : 60_000
}

// ---------------------------------------------------------------------------
// DSH server lifecycle
// ---------------------------------------------------------------------------

function startDshServer (launch) {
  const env = { ...process.env, ...(launch.env || {}) }
  if (!launch.env || !launch.env.ELECTRON_RUN_AS_NODE) {
    // bundled mode needs this flag; every other mode must not inherit it
    delete env.ELECTRON_RUN_AS_NODE
  }

  serverProc = spawn(launch.command, launch.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    detached: process.platform !== 'win32'
  })

  serverProc.stdout.on('data', appendLog)
  serverProc.stderr.on('data', appendLog)

  serverProc.on('error', (err) => {
    appendLog(`spawn error: ${err.message}\n`)
    serverProc = null
  })

  serverProc.on('exit', (code, signal) => {
    appendLog(`dsh exited (code=${code}, signal=${signal})\n`)
    serverProc = null
    if (!quitting && mainWindow) {
      mainWindow.destroy()
      dialog.showErrorBox(
        'DeepSeek Harness server stopped',
        `The local dsh server exited unexpectedly (code=${code}, signal=${signal}).\n\nServer log: ${logPath}`
      )
      quitting = true
      app.quit()
    }
  })
}

function shutdownServer () {
  if (!serverProc) return
  const proc = serverProc
  serverProc = null
  try {
    if (proc.pid && process.platform !== 'win32') process.kill(-proc.pid, 'SIGTERM')
    else proc.kill('SIGTERM')
  } catch {
    try { proc.kill('SIGTERM') } catch { /* already gone */ }
  }
  const killer = setTimeout(() => {
    try {
      if (proc.pid && process.platform !== 'win32') process.kill(-proc.pid, 'SIGKILL')
      else proc.kill('SIGKILL')
    } catch {
      // already gone
    }
  }, 3000)
  killer.unref()
}

function waitForServer (url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume()
        if (res.statusCode >= 200 && res.statusCode < 500) {
          resolve()
        } else {
          retry()
        }
      })
      req.on('error', retry)
      req.setTimeout(2000, () => {
        req.destroy()
        retry()
      })
    }
    const retry = () => {
      if (serverProc && serverProc.exitCode !== null) {
        return reject(new Error(`dsh exited during startup (code ${serverProc.exitCode})`))
      }
      if (Date.now() > deadline) {
        return reject(new Error(`timed out after ${timeoutMs} ms waiting for the dsh server`))
      }
      setTimeout(attempt, READY_POLL_MS)
    }
    attempt()
  })
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createMainWindow () {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: 'DeepSeek Harness',
    autoHideMenuBar: process.platform !== 'darwin',
    backgroundColor: '#0F1115',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow.show())

  // Open external links in the system browser, never in new app windows.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(serverUrl) && /^https?:/i.test(url)) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.loadURL(serverUrl)
}

function installMenu () {
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' }
    ]))
    return
  }
  if (!process.env.DSH_DESKTOP_DEV) Menu.setApplicationMenu(null)
}

// ---------------------------------------------------------------------------
// Auto-update (electron-updater, GitHub releases)
// ---------------------------------------------------------------------------

// On Linux, electron-updater only supports the AppImage distribution — deb
// packages cannot self-replace, so auto-update is disabled there.
function updaterSupported () {
  return app.isPackaged && !!process.env.APPIMAGE
}

function installUpdater () {
  const log = (level) => (message) => appendLog(`[updater:${level}] ${message}\n`)
  autoUpdater.logger = {
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    debug: log('debug')
  }
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => appendLog('[updater] checking for updates\n'))
  autoUpdater.on('update-available', (info) => {
    appendLog(`[updater] update available: ${info.version} (current ${app.getVersion()})\n`)
  })
  autoUpdater.on('update-not-available', (info) => {
    appendLog(`[updater] up to date (${info.version})\n`)
  })
  autoUpdater.on('download-progress', (p) => {
    appendLog(`[updater] downloading ${p.percent.toFixed(1)}% @ ${(p.bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s\n`)
  })
  autoUpdater.on('update-downloaded', (info) => {
    appendLog(`[updater] downloaded ${info.version} — ready to install\n`)
    if (process.env.DSH_DESKTOP_AUTOUPDATE_TEST === '1') {
      appendLog('[updater] test mode: quitting to install immediately\n')
      setImmediate(() => autoUpdater.quitAndInstall())
      return
    }
    const opts = {
      type: 'info',
      title: '更新已就绪',
      message: `DeepSeek Harness Desktop ${info.version} 已下载完成`,
      detail: '立即重启并安装,或稍后退出应用时自动安装。',
      buttons: ['立即重启安装', '稍后'],
      defaultId: 0,
      cancelId: 1
    }
    const choice = mainWindow
      ? dialog.showMessageBoxSync(mainWindow, opts)
      : dialog.showMessageBoxSync(opts)
    if (choice === 0) autoUpdater.quitAndInstall()
  })
  autoUpdater.on('error', (err) => {
    appendLog(`[updater] error: ${err && err.message ? err.message : String(err)}\n`)
  })
}

function startUpdateCheck () {
  if (!updaterSupported()) {
    appendLog(`[updater] auto-update skipped (packaged=${app.isPackaged}, APPIMAGE=${process.env.APPIMAGE || 'unset'} — only the AppImage distribution self-updates on Linux)\n`)
    return
  }
  // Give the window a moment to settle before checking in the background.
  const delay = process.env.DSH_DESKTOP_AUTOUPDATE_TEST === '1' ? 3000 : 8000
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      appendLog(`[updater] check failed: ${err && err.message ? err.message : String(err)}\n`)
    })
  }, delay)
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot () {
  prependExtraPath()
  ensureLogStream()

  let lastError = null
  for (let attempt = 1; attempt <= MAX_PORT_ATTEMPTS; attempt++) {
    serverPort = await findFreePort()
    serverUrl = `http://${DSH_HOST}:${serverPort}`
    const launch = resolveDshLaunch(serverPort)
    launchLabel = launch.label
    const timeoutMs = startupTimeoutMs(launch.viaNpx)
    appendLog(`--- boot attempt ${attempt}: ${launch.label} on ${serverUrl} ---\n`)
    startDshServer(launch)
    try {
      await waitForServer(serverUrl, timeoutMs)
      lastError = null
      break
    } catch (err) {
      lastError = err
      appendLog(`attempt ${attempt} failed: ${err.message}\n`)
      shutdownServer()
    }
  }

  if (lastError) {
    dialog.showErrorBox(
      'DeepSeek Harness failed to start',
      `${lastError.message}\n\n` +
        `Command tried: ${launchLabel}\n` +
        `Tip: set DSH_BIN to a dsh launcher, reinstall the app so vendor/dsh is present,\n` +
        `or install the harness with \`npm i -g @deepseek-ai/dsh\`.\n` +
        `On macOS, Homebrew Node is detected from /opt/homebrew/bin.\n\n` +
        `Server log: ${logPath}\n${serverLogTail.join('')}`
    )
    app.quit()
    return
  }

  appendLog(`dsh ready on ${serverUrl}\n`)
  createMainWindow()
  startUpdateCheck()
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    installMenu()
    installUpdater()
    boot().catch((err) => {
      dialog.showErrorBox('DeepSeek Harness Desktop failed to boot', String(err && err.stack ? err.stack : err))
      app.quit()
    })
  })

  app.on('activate', () => {
    if (mainWindow === null && !quitting && serverUrl) createMainWindow()
  })

  app.on('window-all-closed', () => {
    quitting = true
    shutdownServer()
    app.quit()
  })

  app.on('before-quit', () => {
    quitting = true
    shutdownServer()
  })
}
