'use strict'

const DEFAULT_RELEASES_URL = 'https://github.com/hzhe0083-source/deepseek-harness-desktop/releases/latest'
const INITIAL_CHECK_DELAY_MS = 15_000
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

const UPDATE_MODE = Object.freeze({
  AUTOMATIC: 'automatic',
  RELEASES: 'releases',
  DISABLED: 'disabled'
})

function detectUpdateMode ({ app, platform = process.platform, env = process.env }) {
  if (!app || !app.isPackaged) return UPDATE_MODE.DISABLED
  if (platform === 'darwin') return UPDATE_MODE.AUTOMATIC
  if (platform === 'linux' && typeof env.APPIMAGE === 'string' && env.APPIMAGE.trim()) {
    return UPDATE_MODE.AUTOMATIC
  }
  return UPDATE_MODE.RELEASES
}

function createUpdater ({
  app,
  autoUpdater,
  dialog,
  shell,
  getMainWindow = () => null,
  appendLog = () => {},
  beforeInstall = async () => {},
  afterInstallFailure = async () => {},
  platform = process.platform,
  env = process.env,
  releasesUrl = DEFAULT_RELEASES_URL,
  initialDelayMs = INITIAL_CHECK_DELAY_MS,
  intervalMs = CHECK_INTERVAL_MS,
  timers = {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  }
} = {}) {
  if (!app) throw new TypeError('createUpdater requires app')

  const mode = detectUpdateMode({ app, platform, env })
  let state = 'idle'
  let initialized = false
  let started = false
  let disposed = false
  let manualRequest = false
  let prompting = false
  let installOnQuit = false
  let allowingQuitForInstall = false
  let initialTimer = null
  let intervalTimer = null
  let progressBucket = -1
  let installFailurePromise = null
  const listeners = []
  const handledErrors = new WeakSet()

  function log (message) {
    try {
      appendLog(`[updater] ${message}\n`)
    } catch {
      // Updating must never be able to break application startup or shutdown.
    }
  }

  function currentWindow () {
    const window = getMainWindow()
    if (!window) return null
    if (typeof window.isDestroyed === 'function' && window.isDestroyed()) return null
    return window
  }

  function showMessage (options) {
    if (!dialog || typeof dialog.showMessageBox !== 'function') {
      return Promise.resolve({ response: options.defaultId || 0 })
    }
    const window = currentWindow()
    return window
      ? dialog.showMessageBox(window, options)
      : dialog.showMessageBox(options)
  }

  function errorText (error) {
    if (error && error.message) return error.message
    return String(error || '未知错误')
  }

  function recoverFromInstallFailure (error) {
    if (installFailurePromise) return installFailurePromise
    installFailurePromise = (async () => {
      allowingQuitForInstall = false
      installOnQuit = false
      state = 'recovering'
      manualRequest = false
      let recoveryError = null
      try {
        await afterInstallFailure(error)
      } catch (failure) {
        recoveryError = failure
        log(`恢复 Harness 失败：${errorText(failure)}`)
      }
      state = 'idle'
      if (disposed) return
      await showMessage({
        type: 'error',
        buttons: ['确定'],
        defaultId: 0,
        title: '更新安装失败',
        message: '新版本未能安装，当前版本将继续运行',
        detail: recoveryError
          ? `${errorText(error)}\n\nHarness 恢复失败：${errorText(recoveryError)}`
          : `${errorText(error)}\n\n本地 Harness 已重新启动，你可以稍后重试。`
      })
    })().finally(() => {
      installFailurePromise = null
    })
    return installFailurePromise
  }

  async function reportError (error, manual = manualRequest) {
    if (error && typeof error === 'object') {
      if (handledErrors.has(error)) return
      handledErrors.add(error)
    }
    log(`更新失败：${errorText(error)}`)
    if (state === 'installing' || state === 'recovering' || allowingQuitForInstall) {
      await recoverFromInstallFailure(error)
      return
    }
    state = 'idle'
    manualRequest = false
    if (!manual || disposed) return
    await showMessage({
      type: 'error',
      buttons: ['确定'],
      defaultId: 0,
      title: '检查更新失败',
      message: '暂时无法检查更新',
      detail: `${errorText(error)}\n\n你可以稍后重试，或前往发布页面手动下载。`
    })
  }

  async function installDownloadedUpdate () {
    if (disposed || state !== 'downloaded') return false
    state = 'installing'
    installOnQuit = false
    try {
      await beforeInstall()
      allowingQuitForInstall = true
      autoUpdater.quitAndInstall(false, true)
      return state === 'installing'
    } catch (error) {
      log(`安装更新前准备失败：${errorText(error)}`)
      await reportError(error, true)
      return false
    }
  }

  async function promptForDownloadedUpdate (info = {}) {
    if (disposed || prompting || state === 'installing') return
    prompting = true
    state = 'downloaded'
    manualRequest = false
    const version = info.version ? ` ${info.version}` : ''
    try {
      const result = await showMessage({
        type: 'info',
        buttons: ['立即重启安装', '稍后'],
        defaultId: 0,
        cancelId: 1,
        title: '更新已准备好',
        message: `DeepSeek Harness Desktop${version} 已下载`,
        detail: '选择“立即重启安装”会先安全停止本地 Harness。选择“稍后”则会在退出应用时安装。',
        noLink: true
      })
      if (result.response === 0) {
        await installDownloadedUpdate()
      } else {
        installOnQuit = true
        log('用户选择稍后安装更新')
      }
    } finally {
      prompting = false
    }
  }

  function addUpdaterListener (event, listener) {
    autoUpdater.on(event, listener)
    listeners.push([event, listener])
  }

  function ensureInitialized () {
    if (initialized || mode !== UPDATE_MODE.AUTOMATIC) return
    if (!autoUpdater || typeof autoUpdater.on !== 'function' || typeof autoUpdater.checkForUpdates !== 'function') {
      throw new TypeError('automatic updates require autoUpdater')
    }

    autoUpdater.autoDownload = true
    // A deferred install is handled below so beforeInstall is always awaited.
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.allowPrerelease = false
    autoUpdater.allowDowngrade = false
    autoUpdater.logger = {
      info: (message) => log(String(message)),
      warn: (message) => log(`warning: ${String(message)}`),
      error: (message) => log(`error: ${String(message)}`),
      debug: (message) => log(`debug: ${String(message)}`)
    }

    addUpdaterListener('checking-for-update', () => {
      state = 'checking'
      log('正在检查更新')
    })
    addUpdaterListener('update-available', (info = {}) => {
      state = 'downloading'
      progressBucket = -1
      log(`发现新版本${info.version ? ` ${info.version}` : ''}，开始下载`)
    })
    addUpdaterListener('update-not-available', () => {
      const wasManual = manualRequest
      state = 'idle'
      manualRequest = false
      log('当前已经是最新版本')
      if (wasManual && !disposed) {
        void showMessage({
          type: 'info',
          buttons: ['确定'],
          defaultId: 0,
          title: '没有可用更新',
          message: '当前已经是最新版本。'
        }).catch((error) => log(`无法显示更新结果：${errorText(error)}`))
      }
    })
    addUpdaterListener('download-progress', (progress = {}) => {
      state = 'downloading'
      const percent = Number(progress.percent)
      if (!Number.isFinite(percent)) return
      const bucket = Math.min(10, Math.max(0, Math.floor(percent / 10)))
      if (bucket === progressBucket) return
      progressBucket = bucket
      log(`更新下载进度 ${Math.round(percent)}%`)
    })
    addUpdaterListener('update-downloaded', (info) => {
      state = 'downloaded'
      log(`更新${info && info.version ? ` ${info.version}` : ''}已下载`)
      void promptForDownloadedUpdate(info)
        .catch((error) => reportError(error, true))
        .catch(() => {})
    })
    addUpdaterListener('error', (error) => {
      void reportError(error).catch(() => {})
    })

    if (typeof app.on === 'function') {
      const beforeQuitListener = (event) => {
        if (!installOnQuit || allowingQuitForInstall || state !== 'downloaded') return
        if (event && typeof event.preventDefault === 'function') event.preventDefault()
        void installDownloadedUpdate()
      }
      app.on('before-quit', beforeQuitListener)
      listeners.push(['app:before-quit', beforeQuitListener])
    }
    initialized = true
  }

  async function openReleases () {
    const result = await showMessage({
      type: 'info',
      buttons: ['打开发布页面', '取消'],
      defaultId: 0,
      cancelId: 1,
      title: '通过发布页面更新',
      message: '这个安装格式需要手动更新',
      detail: '为避免系统提权安装带来的风险，请从 GitHub Releases 下载最新安装包。',
      noLink: true
    })
    if (result.response !== 0) return false
    if (!shell || typeof shell.openExternal !== 'function') {
      throw new Error('无法打开系统浏览器')
    }
    await shell.openExternal(releasesUrl)
    return true
  }

  async function checkForUpdates ({ manual = false } = {}) {
    if (disposed) return false
    if (mode === UPDATE_MODE.DISABLED) {
      if (manual) {
        await showMessage({
          type: 'info',
          buttons: ['确定'],
          defaultId: 0,
          title: '开发模式',
          message: '自动更新只在正式安装包中启用。'
        })
      }
      return false
    }
    if (mode === UPDATE_MODE.RELEASES) {
      if (!manual) return false
      try {
        return await openReleases()
      } catch (error) {
        await reportError(error, true)
        return false
      }
    }

    ensureInitialized()
    if (state !== 'idle') {
      if (manual) {
        const message = state === 'downloaded'
          ? '更新已经下载，等待安装。'
          : state === 'installing'
            ? '正在准备安装更新。'
            : '更新检查或下载正在进行中。'
        await showMessage({
          type: 'info',
          buttons: ['确定'],
          defaultId: 0,
          title: '更新进行中',
          message
        })
      }
      return false
    }

    manualRequest = manual
    state = 'checking'
    try {
      const result = await autoUpdater.checkForUpdates()
      if (result && result.downloadPromise && state === 'checking') state = 'downloading'
      if (result && result.downloadPromise && typeof result.downloadPromise.catch === 'function') {
        void result.downloadPromise
          .catch((error) => reportError(error))
          .catch(() => {})
      } else if (state === 'checking') {
        state = 'idle'
        manualRequest = false
      }
      return true
    } catch (error) {
      await reportError(error, manual)
      return false
    }
  }

  function checkNow () {
    return checkForUpdates({ manual: true })
  }

  function start () {
    if (started || disposed) return
    started = true
    if (mode !== UPDATE_MODE.AUTOMATIC) {
      log(mode === UPDATE_MODE.DISABLED
        ? '开发模式下不启用自动更新'
        : '当前安装格式使用发布页面手动更新')
      return
    }
    ensureInitialized()
    initialTimer = timers.setTimeout(() => {
      void checkForUpdates().catch(() => {})
    }, initialDelayMs)
    intervalTimer = timers.setInterval(() => {
      void checkForUpdates().catch(() => {})
    }, intervalMs)
    if (initialTimer && typeof initialTimer.unref === 'function') initialTimer.unref()
    if (intervalTimer && typeof intervalTimer.unref === 'function') intervalTimer.unref()
  }

  function stop () {
    if (initialTimer !== null) timers.clearTimeout(initialTimer)
    if (intervalTimer !== null) timers.clearInterval(intervalTimer)
    initialTimer = null
    intervalTimer = null
    started = false
  }

  function dispose () {
    if (disposed) return
    stop()
    disposed = true
    if (initialized && autoUpdater && typeof autoUpdater.removeListener === 'function') {
      for (const [event, listener] of listeners) {
        if (!event.startsWith('app:')) autoUpdater.removeListener(event, listener)
      }
    }
    if (initialized && typeof app.removeListener === 'function') {
      for (const [event, listener] of listeners) {
        if (event === 'app:before-quit') app.removeListener('before-quit', listener)
      }
    }
  }

  function menuItem () {
    return {
      label: '检查更新…',
      enabled: mode !== UPDATE_MODE.DISABLED,
      click: () => { void checkNow() }
    }
  }

  return {
    mode,
    start,
    stop,
    dispose,
    checkNow,
    checkForUpdates,
    installDownloadedUpdate,
    menuItem,
    getState: () => state
  }
}

module.exports = {
  CHECK_INTERVAL_MS,
  DEFAULT_RELEASES_URL,
  INITIAL_CHECK_DELAY_MS,
  UPDATE_MODE,
  createUpdater,
  detectUpdateMode
}
