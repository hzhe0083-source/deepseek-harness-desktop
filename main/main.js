'use strict'

// DeepSeek Harness Desktop — Electron shell for DeepSeek Harness (DSH).
//
// The app does not reimplement any harness logic. By default it runs the
// DSH runtime bundled in vendor/dsh on Electron's own embedded Node runtime
// (ELECTRON_RUN_AS_NODE=1), so a packaged install needs neither Node.js nor
// a dsh install on the target machine. Release packages require that bundled
// runtime; development runs may still use DSH_BIN or a machine-installed dsh.
//
// Startup: pick a free loopback port -> start dsh web -> poll until the SPA
// is served -> point a sandboxed BrowserWindow at it. Closing the window
// stops the server and quits the app.

const { app, BrowserWindow, Menu, shell, dialog } = require('electron')
const { spawn } = require('node:child_process')
const net = require('node:net')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const { autoUpdater } = require('electron-updater')
const { createUpdater } = require('./updater')
const { hasSameOrigin, isSuccessfulHtmlResponse } = require('./http-safety')

const MAC_APP_DISPLAY_NAME = 'Deepseek desktop'
const DSH_HOST = '127.0.0.1'
const READY_POLL_MS = 250
const MAX_PORT_ATTEMPTS = 3

if (process.platform === 'darwin') {
  const userDataPath = app.getPath('userData')
  app.setName(MAC_APP_DISPLAY_NAME)
  app.setPath('userData', userDataPath)
}

let serverProc = null
let serverPort = null
let serverUrl = null
let mainWindow = null
let quitting = false
let logStream = null
let logPath = null
let serverLogTail = []
let launchLabel = 'dsh'
let serverShutdownPromise = null
let serverStartupFailure = null
let updaterController = null

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
  const candidates = [
    path.join(root, 'vendor', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    // Read old local bundles while transitioning to the complete runtime root.
    path.join(root, 'vendor', 'dsh', 'lib', 'bin.js')
  ]
  for (const bin of candidates) {
    try {
      fs.accessSync(bin, fs.constants.R_OK)
      return bin
    } catch {
      // keep looking
    }
  }
  return null
}

// Resolve how to launch the harness, in priority order:
//   1. DSH_BIN — an explicit external dsh launcher the user pointed at.
//   2. Bundled vendor/dsh on Electron's embedded Node (zero-dependency mode).
//   3. In development only, a machine-installed `dsh` or npm's latest DSH.
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
  if (app.isPackaged) {
    throw new Error('the packaged application is missing its bundled DeepSeek Harness runtime')
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
  if (process.env.DSH_STARTUP_TIMEOUT_MS) {
    const requested = Number(process.env.DSH_STARTUP_TIMEOUT_MS)
    if (Number.isFinite(requested) && requested > 0) return requested
    appendLog('ignored invalid DSH_STARTUP_TIMEOUT_MS; expected a positive number\n')
  }
  return viaNpx ? 180_000 : 60_000
}

// ---------------------------------------------------------------------------
// DSH server lifecycle
// ---------------------------------------------------------------------------

function startDshServer (launch) {
  const env = { ...process.env, ...(launch.env || {}) }
  serverStartupFailure = null
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
    serverStartupFailure = new Error(`could not start dsh: ${err.message}`)
    serverProc = null
  })

  serverProc.on('exit', (code, signal) => {
    appendLog(`dsh exited (code=${code}, signal=${signal})\n`)
    serverProc = null
    if (!quitting) {
      serverStartupFailure = new Error(`dsh exited during startup (code=${code}, signal=${signal})`)
    }
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
      if (proc.exitCode !== null) {
        finish()
      } else if (proc.pid && process.platform !== 'win32') {
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
          if (proc.pid && process.platform !== 'win32') process.kill(-proc.pid, 'SIGKILL')
          else proc.kill('SIGKILL')
        } catch {
          finish()
          return
        }
        // Do not hold an update forever if a platform never reports `exit`.
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
      if (serverStartupFailure) return finish(serverStartupFailure)
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

  mainWindow.once('ready-to-show', () => mainWindow.show())

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
  const updateItem = updaterController
    ? updaterController.menuItem()
    : { label: '检查更新…', enabled: false }
  const versionItem = { label: `版本 ${app.getVersion()}`, enabled: false }
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          updateItem,
          versionItem,
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' }
        ]
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' }
    ]))
    return
  }
  const template = [
    {
      label: '应用',
      submenu: [updateItem, versionItem, { type: 'separator' }, { role: 'quit' }]
    }
  ]
  if (process.env.DSH_DESKTOP_DEV) template.push({ role: 'viewMenu' })
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
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
      await shutdownServer()
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
  if (mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.loadURL(serverUrl)
    mainWindow.show()
  } else {
    createMainWindow()
  }
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
    ensureLogStream()
    updaterController = createUpdater({
      app,
      autoUpdater,
      dialog,
      shell,
      getMainWindow: () => mainWindow,
      appendLog,
      beforeInstall: async () => {
        quitting = true
        await shutdownServer()
      },
      afterInstallFailure: async () => {
        quitting = false
        await boot()
      }
    })
    installMenu()
    updaterController.start()
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
    void shutdownServer()
    app.quit()
  })

  app.on('before-quit', () => {
    quitting = true
    void shutdownServer()
  })
}
