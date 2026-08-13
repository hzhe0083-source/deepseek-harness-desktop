'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const test = require('node:test')

const {
  CHECK_INTERVAL_MS,
  UPDATE_MODE,
  createUpdater,
  detectUpdateMode
} = require('../main/updater')

function flush () {
  return new Promise((resolve) => setImmediate(resolve))
}

function deferred () {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

class FakeApp extends EventEmitter {
  constructor (isPackaged = true) {
    super()
    this.isPackaged = isPackaged
  }
}

class FakeAutoUpdater extends EventEmitter {
  constructor (check = async () => null) {
    super()
    this.check = check
    this.checkCalls = 0
    this.quitCalls = []
  }

  checkForUpdates () {
    this.checkCalls++
    return this.check()
  }

  quitAndInstall (...args) {
    this.quitCalls.push(args)
  }
}

function makeDialog (...responses) {
  const calls = []
  return {
    calls,
    async showMessageBox (...args) {
      const options = args.at(-1)
      calls.push(options)
      return { response: responses.length ? responses.shift() : 0 }
    }
  }
}

function makeTimers () {
  const timeouts = []
  const intervals = []
  return {
    timeouts,
    intervals,
    timers: {
      setTimeout (fn, delay) {
        const timer = { fn, delay, unref () {} }
        timeouts.push(timer)
        return timer
      },
      clearTimeout (timer) {
        const index = timeouts.indexOf(timer)
        if (index >= 0) timeouts.splice(index, 1)
      },
      setInterval (fn, delay) {
        const timer = { fn, delay, unref () {} }
        intervals.push(timer)
        return timer
      },
      clearInterval (timer) {
        const index = intervals.indexOf(timer)
        if (index >= 0) intervals.splice(index, 1)
      }
    }
  }
}

test('detectUpdateMode only enables direct updates for packaged macOS and AppImage', () => {
  assert.equal(detectUpdateMode({ app: new FakeApp(true), platform: 'darwin', env: {} }), UPDATE_MODE.AUTOMATIC)
  assert.equal(detectUpdateMode({ app: new FakeApp(true), platform: 'linux', env: { APPIMAGE: '/tmp/app.AppImage' } }), UPDATE_MODE.AUTOMATIC)
  assert.equal(detectUpdateMode({ app: new FakeApp(true), platform: 'linux', env: {} }), UPDATE_MODE.RELEASES)
  assert.equal(detectUpdateMode({ app: new FakeApp(true), platform: 'win32', env: {} }), UPDATE_MODE.RELEASES)
  assert.equal(detectUpdateMode({ app: new FakeApp(false), platform: 'darwin', env: {} }), UPDATE_MODE.DISABLED)
})

test('start schedules an initial and six-hour check and prevents overlapping checks', async () => {
  const firstCheck = deferred()
  const autoUpdater = new FakeAutoUpdater(() => firstCheck.promise)
  const scheduled = makeTimers()
  const controller = createUpdater({
    app: new FakeApp(),
    autoUpdater,
    dialog: makeDialog(),
    shell: {},
    platform: 'darwin',
    timers: scheduled.timers,
    initialDelayMs: 123
  })

  controller.start()
  assert.equal(scheduled.timeouts.length, 1)
  assert.equal(scheduled.timeouts[0].delay, 123)
  assert.equal(scheduled.intervals.length, 1)
  assert.equal(scheduled.intervals[0].delay, CHECK_INTERVAL_MS)
  assert.equal(autoUpdater.autoDownload, true)
  assert.equal(autoUpdater.autoInstallOnAppQuit, false)

  scheduled.timeouts[0].fn()
  scheduled.intervals[0].fn()
  await flush()
  assert.equal(autoUpdater.checkCalls, 1)

  firstCheck.resolve(null)
  await flush()
  scheduled.intervals[0].fn()
  await flush()
  assert.equal(autoUpdater.checkCalls, 2)
  controller.dispose()
})

test('manual check reports when the installed version is current', async () => {
  const dialog = makeDialog()
  const autoUpdater = new FakeAutoUpdater(async () => {
    queueMicrotask(() => autoUpdater.emit('update-not-available', { version: '1.0.0' }))
    return null
  })
  const controller = createUpdater({
    app: new FakeApp(),
    autoUpdater,
    dialog,
    shell: {},
    platform: 'darwin'
  })

  await controller.checkNow()
  await flush()
  assert.equal(dialog.calls.length, 1)
  assert.equal(dialog.calls[0].title, '没有可用更新')
  controller.dispose()
})

test('background errors are logged silently while manual errors are shown', async () => {
  const backgroundError = new Error('background offline')
  const backgroundDialog = makeDialog()
  const backgroundLogs = []
  const background = createUpdater({
    app: new FakeApp(),
    autoUpdater: new FakeAutoUpdater(async () => { throw backgroundError }),
    dialog: backgroundDialog,
    shell: {},
    platform: 'darwin',
    appendLog: (line) => backgroundLogs.push(line)
  })
  await background.checkForUpdates()
  assert.equal(backgroundDialog.calls.length, 0)
  assert.match(backgroundLogs.join(''), /background offline/)

  const manualDialog = makeDialog()
  const manual = createUpdater({
    app: new FakeApp(),
    autoUpdater: new FakeAutoUpdater(async () => { throw new Error('manual offline') }),
    dialog: manualDialog,
    shell: {},
    platform: 'darwin'
  })
  await manual.checkNow()
  assert.equal(manualDialog.calls.length, 1)
  assert.equal(manualDialog.calls[0].title, '检查更新失败')
  background.dispose()
  manual.dispose()
})

test('a downloaded update waits for beforeInstall before restarting', async () => {
  const readyToInstall = deferred()
  const autoUpdater = new FakeAutoUpdater()
  const dialog = makeDialog(0)
  let beforeInstallCalls = 0
  const controller = createUpdater({
    app: new FakeApp(),
    autoUpdater,
    dialog,
    shell: {},
    platform: 'darwin',
    beforeInstall: async () => {
      beforeInstallCalls++
      await readyToInstall.promise
    }
  })
  controller.start()
  autoUpdater.emit('update-available', { version: '2.0.0' })
  autoUpdater.emit('update-downloaded', { version: '2.0.0' })
  await flush()

  assert.equal(beforeInstallCalls, 1)
  assert.equal(autoUpdater.quitCalls.length, 0)
  readyToInstall.resolve()
  await flush()
  assert.deepEqual(autoUpdater.quitCalls, [[false, true]])
  controller.dispose()
})

test('choosing later installs on quit and still awaits beforeInstall', async () => {
  const app = new FakeApp()
  const autoUpdater = new FakeAutoUpdater()
  const dialog = makeDialog(1)
  let prepared = false
  const controller = createUpdater({
    app,
    autoUpdater,
    dialog,
    shell: {},
    platform: 'darwin',
    beforeInstall: async () => { prepared = true }
  })
  controller.start()
  autoUpdater.emit('update-downloaded', { version: '2.1.0' })
  await flush()

  let prevented = false
  app.emit('before-quit', { preventDefault: () => { prevented = true } })
  await flush()
  assert.equal(prevented, true)
  assert.equal(prepared, true)
  assert.deepEqual(autoUpdater.quitCalls, [[false, true]])
  controller.dispose()
})

test('an installer error is visible and recovers after the Harness was stopped', async () => {
  const autoUpdater = new FakeAutoUpdater()
  const dialog = makeDialog(0)
  let stopped = false
  let recovered = false
  autoUpdater.quitAndInstall = function (...args) {
    this.quitCalls.push(args)
    this.emit('error', new Error('replacement failed'))
  }
  const controller = createUpdater({
    app: new FakeApp(),
    autoUpdater,
    dialog,
    shell: {},
    platform: 'darwin',
    beforeInstall: async () => { stopped = true },
    afterInstallFailure: async () => { recovered = true }
  })
  controller.start()
  autoUpdater.emit('update-downloaded', { version: '2.2.0' })
  await flush()
  await flush()

  assert.equal(stopped, true)
  assert.equal(recovered, true)
  assert.equal(controller.getState(), 'idle')
  assert.equal(dialog.calls.at(-1).title, '更新安装失败')
  controller.dispose()
})

test('Linux package installs never invoke DebUpdater and instead open Releases on request', async () => {
  const autoUpdater = new FakeAutoUpdater()
  const dialog = makeDialog(0)
  const opened = []
  const controller = createUpdater({
    app: new FakeApp(),
    autoUpdater,
    dialog,
    shell: { openExternal: async (url) => { opened.push(url) } },
    platform: 'linux',
    env: {}
  })

  controller.start()
  assert.equal(autoUpdater.listenerCount('error'), 0)
  await controller.checkNow()
  assert.equal(autoUpdater.checkCalls, 0)
  assert.equal(dialog.calls[0].title, '通过发布页面更新')
  assert.deepEqual(opened, ['https://github.com/hzhe0083-source/deepseek-harness-desktop/releases/latest'])
  controller.dispose()
})
