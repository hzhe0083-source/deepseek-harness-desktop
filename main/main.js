'use strict'

// DeepSeek Harness Desktop — Electron shell for DeepSeek Harness (DSH).
//
// The app does not reimplement any harness logic. It first uses DSH_BIN or a
// machine-installed dsh. When neither exists, it downloads one pinned runtime
// asset into the app's user-data directory and reuses that verified cache on
// later launches. Managed runtimes execute on Electron's embedded Node, so a
// clean machine needs no separate Node/npm installation.
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
const desktopPackage = require('../package.json')
const { resolveRuntime } = require('./runtime-manager')
const { hasSameOrigin, isSuccessfulHtmlResponse } = require('./http-safety')
const { terminateProcessTree } = require('./win-process')

// GNOME/Ubuntu match the running window to the .desktop file via WM_CLASS.
// Keep this aligned with package.json desktopName and linux.desktop.entry.StartupWMClass.
if (process.platform === 'linux') {
  app.setDesktopName('deepseek-harness-desktop.desktop')
}
if (process.platform === 'win32') {
  app.setAppUserModelId('com.hzhe0083.deepseek-harness-desktop')
}

// Ubuntu 22.04+ often ships only libfuse3. AppImage self-update restarts the
// new file directly; without fuse2 that restart is silent. Inherit this so
// electron-updater's child AppImage can extract-and-run.
if (process.platform === 'linux' && process.env.APPIMAGE && !process.env.APPIMAGE_EXTRACT_AND_RUN) {
  const fuse2 = [
    '/lib/x86_64-linux-gnu/libfuse.so.2',
    '/usr/lib/x86_64-linux-gnu/libfuse.so.2',
    '/lib64/libfuse.so.2'
  ].some((candidate) => fs.existsSync(candidate))
  if (!fuse2) process.env.APPIMAGE_EXTRACT_AND_RUN = '1'
}

const DSH_HOST = '127.0.0.1'
const READY_POLL_MS = 250
const MAX_PORT_ATTEMPTS = 3

let serverProc = null
let serverFailure = null
let serverPort = null
let serverUrl = null
let mainWindow = null
let booting = true
let quitting = false
let logStream = null
let logPath = null
let serverLogTail = []
let launchLabel = 'dsh'
let runtimeProgressWindow = null
let pendingRuntimeProgress = null
let serverShutdownPromise = null
let quitCleanupStarted = false
let quitCleanupComplete = false

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
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
    dirs.push(path.join(appdata, 'npm'))
  }
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
  const fallback = process.platform === 'win32' ? (process.env.PATH || '') : (process.env.PATH || '/usr/bin:/bin')
  process.env.PATH = extras ? `${extras}${path.delimiter}${fallback}` : fallback
}

function startupTimeoutMs () {
  if (process.env.DSH_STARTUP_TIMEOUT_MS) {
    const requested = Number(process.env.DSH_STARTUP_TIMEOUT_MS)
    if (Number.isFinite(requested) && requested > 0) return requested
    appendLog('ignored invalid DSH_STARTUP_TIMEOUT_MS; expected a positive number\n')
  }
  return 60_000
}

function launchForPort (runtime, port) {
  return {
    ...runtime,
    args: [
      ...runtime.prefixArgs,
      'web',
      '--host', DSH_HOST,
      '--port', String(port)
    ]
  }
}

function formatBytes (bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function runtimeProgressState (event) {
  if (event.phase === 'download') {
    const hasTotal = Number.isFinite(event.totalBytes) && event.totalBytes > 0
    const percent = hasTotal
      ? Math.min(100, Math.round((event.downloadedBytes / event.totalBytes) * 100))
      : null
    return {
      title: '正在准备 DeepSeek Harness',
      message: '首次启动需下载运行时，后续启动会直接复用。',
      detail: hasTotal
        ? `${formatBytes(event.downloadedBytes)} / ${formatBytes(event.totalBytes)}`
        : `已下载 ${formatBytes(event.downloadedBytes)}`,
      percent
    }
  }
  if (event.phase === 'verify') {
    return {
      title: '正在验证下载内容',
      message: '正在校验运行时完整性。',
      detail: event.label || '',
      percent: 100
    }
  }
  return {
    title: '正在安装 DeepSeek Harness',
    message: '正在解压到用户缓存，无需管理员权限。',
    detail: event.label || '',
    percent: null
  }
}

function renderRuntimeProgress () {
  if (!runtimeProgressWindow || runtimeProgressWindow.isDestroyed() || !pendingRuntimeProgress) return
  const state = runtimeProgressState(pendingRuntimeProgress)
  runtimeProgressWindow.webContents
    .executeJavaScript(`window.setRuntimeProgress(${JSON.stringify(state)})`)
    .catch(() => {})
  runtimeProgressWindow.setProgressBar(state.percent === null ? 2 : state.percent / 100)
}

function createRuntimeProgressWindow () {
  if (runtimeProgressWindow) return
  runtimeProgressWindow = new BrowserWindow({
    width: 520,
    height: 230,
    resizable: false,
    maximizable: false,
    minimizable: false,
    closable: false,
    show: false,
    title: '准备 DeepSeek Harness',
    backgroundColor: '#0F1115',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  })
  runtimeProgressWindow.on('closed', () => {
    runtimeProgressWindow = null
  })
  runtimeProgressWindow.once('ready-to-show', () => runtimeProgressWindow.show())
  runtimeProgressWindow.webContents.on('did-finish-load', renderRuntimeProgress)
  const html = `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>准备 DeepSeek Harness</title>
<style>
  :root { color-scheme: dark; font-family: system-ui, sans-serif; background: #0f1115; color: #f4f6f8; }
  body { margin: 0; padding: 30px 34px; }
  h1 { margin: 0 0 10px; font-size: 20px; font-weight: 650; }
  p { margin: 0 0 20px; color: #aeb6c2; font-size: 14px; line-height: 1.5; }
  progress { width: 100%; height: 10px; accent-color: #6f8cff; }
  #detail { margin-top: 9px; color: #778292; font-size: 12px; }
</style>
<h1 id="title">正在准备 DeepSeek Harness</h1>
<p id="message">首次启动需下载运行时。</p>
<progress id="progress"></progress>
<div id="detail"></div>
<script>
  window.setRuntimeProgress = ({ title, message, detail, percent }) => {
    document.getElementById('title').textContent = title
    document.getElementById('message').textContent = message
    document.getElementById('detail').textContent = detail
    const progress = document.getElementById('progress')
    if (percent === null) progress.removeAttribute('value')
    else progress.value = percent
  }
</script>`
  runtimeProgressWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
}

function updateRuntimeProgress (event) {
  if (event.phase === 'ready') {
    closeRuntimeProgressWindow()
    return
  }
  pendingRuntimeProgress = event
  createRuntimeProgressWindow()
  renderRuntimeProgress()
}

function closeRuntimeProgressWindow () {
  pendingRuntimeProgress = null
  if (runtimeProgressWindow && !runtimeProgressWindow.isDestroyed()) {
    runtimeProgressWindow.destroy()
  }
  runtimeProgressWindow = null
}

// ---------------------------------------------------------------------------
// DSH server lifecycle
// ---------------------------------------------------------------------------

function startDshServer (launch) {
  serverFailure = null
  const env = { ...process.env, ...(launch.env || {}) }
  if (!launch.env || !launch.env.ELECTRON_RUN_AS_NODE) {
    // Only the managed runtime uses Electron as Node. Never leak this flag to
    // an explicitly configured or machine-installed dsh launcher.
    delete env.ELECTRON_RUN_AS_NODE
  }

  const winCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(launch.command)
  const proc = spawn(launch.command, launch.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    detached: process.platform !== 'win32',
    shell: winCmd,
    windowsHide: true
  })
  serverProc = proc

  proc.stdout.on('data', appendLog)
  proc.stderr.on('data', appendLog)

  proc.on('error', (err) => {
    appendLog(`spawn error: ${err.message}\n`)
    if (serverProc !== proc) return
    serverFailure = err
    serverProc = null
  })

  proc.on('exit', (code, signal) => {
    appendLog(`dsh exited (code=${code}, signal=${signal})\n`)
    if (serverProc !== proc) return
    serverFailure = new Error(`dsh exited during startup (code=${code}, signal=${signal})`)
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
  if (serverShutdownPromise) return serverShutdownPromise
  if (!serverProc) return Promise.resolve()
  const proc = serverProc
  serverProc = null

  serverShutdownPromise = new Promise((resolveShutdown) => {
    let settled = false
    let killer = null
    let forcedFinish = null
    const finish = () => {
      if (settled) return
      settled = true
      if (killer) clearTimeout(killer)
      if (forcedFinish) clearTimeout(forcedFinish)
      serverShutdownPromise = null
      resolveShutdown()
    }
    proc.once('exit', finish)

    try {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        finish()
      } else if (process.platform === 'win32') {
        // Kill the whole tree: the direct child may only be a cmd.exe shim,
        // and its node.exe server would survive a plain proc.kill().
        if (!terminateProcessTree(proc.pid)) {
          appendLog('[shutdown] taskkill failed; falling back to killing the direct child\n')
        }
        try { proc.kill('SIGKILL') } catch { /* taskkill already removed it */ }
      } else if (proc.pid) {
        process.kill(-proc.pid, 'SIGTERM')
      } else {
        proc.kill('SIGTERM')
      }
    } catch {
      try { proc.kill('SIGTERM') } catch { finish() }
    }

    if (!settled) {
      killer = setTimeout(() => {
        try {
          if (process.platform === 'win32') {
            if (!terminateProcessTree(proc.pid)) {
              appendLog('[shutdown] taskkill failed on escalation; killing the direct child\n')
            }
            proc.kill('SIGKILL')
          } else if (proc.pid) {
            process.kill(-proc.pid, 'SIGKILL')
          } else {
            proc.kill('SIGKILL')
          }
        } catch {
          finish()
          return
        }
        forcedFinish = setTimeout(finish, 1000)
        forcedFinish.unref()
      }, 3000)
      killer.unref()
    }
  })
  return serverShutdownPromise
}

function waitForServer (url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    let settled = false
    let retryTimer = null
    const finish = (error) => {
      if (settled) return
      settled = true
      if (retryTimer) clearTimeout(retryTimer)
      if (error) reject(error)
      else resolve()
    }
    const attempt = () => {
      if (settled) return
      let requestFinished = false
      const completeRequest = (callback) => {
        if (requestFinished || settled) return
        requestFinished = true
        callback()
      }
      const req = http.get(url, (res) => {
        res.resume()
        completeRequest(() => {
          if (isSuccessfulHtmlResponse(res.statusCode, res.headers['content-type'])) finish()
          else retry()
        })
      })
      req.on('error', () => completeRequest(retry))
      req.setTimeout(2000, () => {
        completeRequest(() => {
          req.destroy()
          retry()
        })
      })
    }
    const retry = () => {
      if (settled) return
      if (serverFailure) return finish(serverFailure)
      if (serverProc && serverProc.exitCode !== null) {
        return finish(new Error(`dsh exited during startup (code ${serverProc.exitCode})`))
      }
      if (Date.now() > deadline) {
        return finish(new Error(`timed out after ${timeoutMs} ms waiting for the dsh server`))
      }
      retryTimer = setTimeout(attempt, READY_POLL_MS)
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

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    mainWindow.focus()
    if (process.platform === 'linux') {
      mainWindow.setAlwaysOnTop(true)
      mainWindow.setAlwaysOnTop(false)
    }
  })

  // Open external links in the system browser, never in new app windows.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (hasSameOrigin(url, serverUrl)) return
    event.preventDefault()
    if (/^https?:/i.test(url)) void shell.openExternal(url)
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

  let runtime
  try {
    runtime = await resolveRuntime({
      userDataDir: app.getPath('userData'),
      desktopVersion: app.getVersion(),
      runtimeVersion: desktopPackage.deepseekHarness.runtimeVersion,
      electronAbi: process.versions.modules,
      execPath: process.execPath,
      env: process.env,
      platform: process.platform,
      arch: process.arch,
      onProgress: updateRuntimeProgress
    })
    closeRuntimeProgressWindow()
    appendLog(`runtime selected: ${runtime.label} (${runtime.source})\n`)
  } catch (err) {
    closeRuntimeProgressWindow()
    dialog.showErrorBox(
      'DeepSeek Harness runtime could not be prepared',
      `${err.message}\n\n` +
        'Check your network connection, install @deepseek-ai/dsh locally, or set DSH_BIN.\n\n' +
        `Desktop log: ${logPath}`
    )
    app.quit()
    return
  }

  let lastError = null
  for (let attempt = 1; attempt <= MAX_PORT_ATTEMPTS; attempt++) {
    serverPort = await findFreePort()
    serverUrl = `http://${DSH_HOST}:${serverPort}`
    const launch = launchForPort(runtime, serverPort)
    launchLabel = launch.label
    const timeoutMs = startupTimeoutMs()
    appendLog(`--- boot attempt ${attempt}: ${launch.label} on ${serverUrl} ---\n`)
    startDshServer(launch)
    try {
      await waitForServer(serverUrl, timeoutMs)
      lastError = null
      break
    } catch (err) {
      lastError = err
      appendLog(`attempt ${attempt} failed: ${err.message}\n`)
      await shutdownServer()
    }
  }

  if (lastError) {
    dialog.showErrorBox(
      'DeepSeek Harness failed to start',
      `${lastError.message}\n\n` +
        `Command tried: ${launchLabel}\n` +
        `Tip: set DSH_BIN to a dsh launcher or install the harness with\n` +
        `\`npm i -g @deepseek-ai/dsh\`.\n` +
        `On macOS, Homebrew Node is detected from /opt/homebrew/bin.\n\n` +
        `Server log: ${logPath}\n${serverLogTail.join('')}`
    )
    app.quit()
    return
  }

  appendLog(`dsh ready on ${serverUrl}\n`)
  createMainWindow()
  booting = false
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
      if (process.platform === 'linux') {
        mainWindow.setAlwaysOnTop(true)
        mainWindow.setAlwaysOnTop(false)
      }
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
    if (mainWindow === null && !booting && !quitting && serverUrl) createMainWindow()
  })

  app.on('window-all-closed', () => {
    if (booting) return
    quitting = true
    app.quit()
  })

  app.on('before-quit', (event) => {
    quitting = true
    if (quitCleanupComplete) return
    event.preventDefault()
    if (quitCleanupStarted) return
    quitCleanupStarted = true
    void shutdownServer()
      .catch((err) => appendLog(`server shutdown failed: ${err.message}\n`))
      .finally(() => {
        quitCleanupComplete = true
        app.quit()
      })
  })
}
