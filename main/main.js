'use strict'

// DeepSeek Harness Desktop — Electron shell for DeepSeek Harness (DSH).
//
// The app does not reimplement any harness logic. By default it runs the
// DSH copy bundled in vendor/dsh on Electron's own embedded Node runtime
// (ELECTRON_RUN_AS_NODE=1), so a packaged install needs neither Node.js nor
// a dsh install on the target machine. A local `dsh` on PATH / DSH_BIN is
// only used when the bundle is absent or explicitly requested.
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

const DSH_HOST = '127.0.0.1'
const STARTUP_TIMEOUT_MS = 60_000
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

// Resolve how to launch the harness, highest fidelity first:
//   1. DSH_BIN — an explicit external dsh launcher the user pointed at.
//   2. Bundled vendor/dsh on Electron's embedded Node (zero-dependency mode).
//   3. `dsh` on PATH — development convenience / fallback.
function resolveDshLaunch (port) {
  const webArgs = ['web', '--host', DSH_HOST, '--port', String(port)]
  if (process.env.DSH_BIN) {
    return {
      command: process.env.DSH_BIN,
      args: webArgs,
      env: {},
      description: `external DSH_BIN (${process.env.DSH_BIN})`
    }
  }
  const bundledBin = bundledDshBin()
  if (bundledBin) {
    return {
      command: process.execPath,
      args: ['--expose-internals', bundledBin, ...webArgs],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      description: `bundled dsh on Electron's embedded Node ${process.versions.node}`
    }
  }
  return { command: 'dsh', args: webArgs, env: {}, description: 'dsh on PATH' }
}

// ---------------------------------------------------------------------------
// DSH server lifecycle
// ---------------------------------------------------------------------------

function startDshServer (port) {
  const launch = resolveDshLaunch(port)
  const env = { ...process.env, ...launch.env }

  appendLog(`spawning: ${launch.description}\n`)
  serverProc = spawn(launch.command, launch.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env
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
    proc.kill('SIGTERM')
  } catch {
    // already gone
  }
  const killer = setTimeout(() => {
    try {
      proc.kill('SIGKILL')
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
    autoHideMenuBar: true,
    backgroundColor: '#0e1116',
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

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot () {
  ensureLogStream()
  appendLog(`--- boot: ${resolveDshLaunch(0).description} ---\n`)

  let lastError = null
  for (let attempt = 1; attempt <= MAX_PORT_ATTEMPTS; attempt++) {
    serverPort = await findFreePort()
    serverUrl = `http://${DSH_HOST}:${serverPort}`
    appendLog(`attempt ${attempt}: starting dsh web on ${serverUrl}\n`)
    startDshServer(serverPort)
    try {
      await waitForServer(serverUrl, STARTUP_TIMEOUT_MS)
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
        `Launch mode: ${resolveDshLaunch(0).description}\n` +
        `Tip: set DSH_BIN to a dsh launcher, or reinstall the app so vendor/dsh is present.\n\n` +
        `Server log: ${logPath}\n${serverLogTail.join('')}`
    )
    app.quit()
    return
  }

  appendLog(`dsh ready on ${serverUrl}\n`)
  createMainWindow()
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
    // Keep the default menu only while developing (needed for DevTools).
    if (!process.env.DSH_DESKTOP_DEV) Menu.setApplicationMenu(null)
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
