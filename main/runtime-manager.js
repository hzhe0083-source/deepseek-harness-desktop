'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const REPOSITORY = 'hzhe0083-source/deepseek-harness-desktop'
const RUNTIME_PACKAGE = '@deepseek-ai/dsh'
const SUPPORTED_TARGETS = new Set([
  'linux-x64',
  'linux-arm64',
  'darwin-arm64'
])

function cleanVersion (value, label = 'version') {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required`)
  }
  const version = value.trim().replace(/^v/, '')
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(version)) {
    throw new Error(`Invalid ${label}: ${value}`)
  }
  return version
}

function assertSupportedTarget (platform, arch) {
  const target = `${platform}-${arch}`
  if (!SUPPORTED_TARGETS.has(target)) {
    throw new Error(
      `Unsupported DSH runtime target: ${target}. ` +
      'Supported targets: linux-x64, linux-arm64, darwin-arm64.'
    )
  }
  return target
}

function isExecutable (candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK)
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}

/**
 * Find a machine-installed dsh launcher without mutating PATH.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.platform]
 * @param {string} [options.homedir]
 * @returns {string|null}
 */
function findInstalledDsh (options = {}) {
  const env = options.env || process.env
  const platform = options.platform || process.platform
  const homedir = options.homedir || env.HOME || env.USERPROFILE || os.homedir()
  const candidates = []

  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, 'dsh'))
  }
  if (env.NVM_BIN) candidates.push(path.join(env.NVM_BIN, 'dsh'))
  if (platform === 'darwin') {
    candidates.push('/opt/homebrew/bin/dsh', '/usr/local/bin/dsh')
  }
  if (homedir) {
    candidates.push(
      path.join(homedir, '.nvm', 'current', 'bin', 'dsh'),
      path.join(homedir, '.local', 'bin', 'dsh'),
      path.join(homedir, 'Library', 'pnpm', 'dsh'),
      path.join(homedir, '.local', 'share', 'pnpm', 'dsh'),
      path.join(homedir, '.npm-global', 'bin', 'dsh')
    )

    const nvmVersions = path.join(homedir, '.nvm', 'versions', 'node')
    try {
      for (const version of fs.readdirSync(nvmVersions).sort().reverse()) {
        candidates.push(path.join(nvmVersions, version, 'bin', 'dsh'))
      }
    } catch {
      // nvm is optional
    }
  }

  for (const candidate of new Set(candidates)) {
    if (isExecutable(candidate)) return candidate
  }
  return null
}

function runtimeAssetName ({ version, platform, arch }) {
  const clean = cleanVersion(version, 'runtimeVersion')
  assertSupportedTarget(platform, arch)
  return `dsh-runtime-${clean}-${platform}-${arch}.tar.gz`
}

function managedRuntimeBin ({ userDataDir, version, platform, arch }) {
  if (typeof userDataDir !== 'string' || userDataDir.trim() === '') {
    throw new Error('userDataDir is required')
  }
  const clean = cleanVersion(version, 'runtimeVersion')
  const target = assertSupportedTarget(platform, arch)
  return path.join(userDataDir, 'runtime', clean, target, 'dsh', 'lib', 'bin.js')
}

function installDirForBin (bin) {
  return path.dirname(path.dirname(path.dirname(bin)))
}

function parseChecksum (value, label) {
  const match = String(value || '').match(/\b([a-fA-F0-9]{64})\b/)
  if (!match) throw new Error(`Invalid SHA-256 checksum from ${label}`)
  return match[1].toLowerCase()
}

async function hashFile (filename) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}

async function readRuntimePackage (installDir, runtimeVersion) {
  const packageFile = path.join(installDir, 'dsh', 'package.json')
  const bin = path.join(installDir, 'dsh', 'lib', 'bin.js')
  const binStat = await fsp.lstat(bin)
  const packageStat = await fsp.lstat(packageFile)
  if (!binStat.isFile() || !packageStat.isFile()) {
    throw new Error('Runtime archive must contain regular dsh/lib/bin.js and dsh/package.json files')
  }

  let manifest
  try {
    manifest = JSON.parse(await fsp.readFile(packageFile, 'utf8'))
  } catch (error) {
    throw new Error(`Invalid runtime dsh/package.json: ${error.message}`)
  }
  if (manifest.name !== RUNTIME_PACKAGE || manifest.version !== runtimeVersion) {
    throw new Error(
      `Runtime package mismatch: expected ${RUNTIME_PACKAGE}@${runtimeVersion}, ` +
      `got ${manifest.name || '<unknown>'}@${manifest.version || '<unknown>'}`
    )
  }

  return { bin, packageFile }
}

async function verifiedCache (context, expectedChecksum) {
  const { installDir, runtimeVersion, desktopVersion, electronAbi, platform, arch, asset } = context
  const markerFile = path.join(installDir, '.verified.json')
  try {
    const marker = JSON.parse(await fsp.readFile(markerFile, 'utf8'))
    if (
      marker.schemaVersion !== 2 ||
      marker.runtimeVersion !== runtimeVersion ||
      marker.desktopVersion !== desktopVersion ||
      marker.electronAbi !== electronAbi ||
      marker.platform !== platform ||
      marker.arch !== arch ||
      marker.asset !== asset ||
      !/^[a-f0-9]{64}$/.test(marker.checksum || '') ||
      (expectedChecksum && marker.checksum !== expectedChecksum)
    ) return false

    const { bin, packageFile } = await readRuntimePackage(installDir, runtimeVersion)
    const [binSha256, packageSha256] = await Promise.all([
      hashFile(bin),
      hashFile(packageFile)
    ])
    return binSha256 === marker.binSha256 && packageSha256 === marker.packageSha256
  } catch {
    return false
  }
}

function managedLaunch (context, source) {
  return {
    command: context.execPath,
    prefixArgs: ['--expose-internals', context.bin],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    label: `managed ${RUNTIME_PACKAGE}@${context.runtimeVersion}`,
    source
  }
}

async function fetchResponse (fetchImpl, url) {
  let response
  try {
    response = await fetchImpl(url)
  } catch (error) {
    throw new Error(`Failed to download ${url}: ${error.message}`)
  }
  if (!response || !response.ok) {
    const status = response ? `${response.status} ${response.statusText || ''}`.trim() : 'no response'
    throw new Error(`Failed to download ${url}: HTTP ${status}`)
  }
  return response
}

async function downloadArchive (fetchImpl, url, destination, report, label) {
  const response = await fetchResponse(fetchImpl, url)
  const totalHeader = response.headers && response.headers.get
    ? Number(response.headers.get('content-length'))
    : NaN
  const totalBytes = Number.isFinite(totalHeader) && totalHeader >= 0 ? totalHeader : undefined
  const hash = crypto.createHash('sha256')
  const output = await fsp.open(destination, 'wx')
  let downloadedBytes = 0

  try {
    report({ phase: 'download', downloadedBytes, totalBytes, label })
    if (response.body) {
      for await (const value of response.body) {
        const chunk = Buffer.from(value)
        await output.write(chunk)
        hash.update(chunk)
        downloadedBytes += chunk.length
        report({ phase: 'download', downloadedBytes, totalBytes, label })
      }
    } else {
      const chunk = Buffer.from(await response.arrayBuffer())
      await output.write(chunk)
      hash.update(chunk)
      downloadedBytes = chunk.length
      report({ phase: 'download', downloadedBytes, totalBytes, label })
    }
  } finally {
    await output.close()
  }

  return hash.digest('hex')
}

async function remoteChecksum (fetchImpl, url) {
  const response = await fetchResponse(fetchImpl, `${url}.sha256`)
  return parseChecksum(await response.text(), `${url}.sha256`)
}

/**
 * Resolve (and, when needed, install) the DSH runtime for the desktop app.
 *
 * Priority: DSH_BIN -> machine dsh -> verified managed cache -> download.
 */
async function resolveRuntime (options = {}) {
  const env = options.env || process.env
  const platform = options.platform || process.platform
  const arch = options.arch || process.arch

  if (env.DSH_BIN) {
    return {
      command: env.DSH_BIN,
      prefixArgs: [],
      env: {},
      label: `DSH_BIN (${env.DSH_BIN})`,
      source: 'env'
    }
  }

  const installed = findInstalledDsh({
    env,
    platform,
    homedir: options.homedir
  })
  if (installed) {
    const installedDir = path.dirname(installed)
    const pathDirs = String(env.PATH || '').split(path.delimiter).filter(Boolean)
    const launchPath = pathDirs.includes(installedDir)
      ? env.PATH || ''
      : `${installedDir}${path.delimiter}${env.PATH || ''}`
    return {
      command: installed,
      prefixArgs: [],
      // npm/pnpm/nvm launchers commonly use `#!/usr/bin/env node`. Ensure the
      // Node executable beside the discovered launcher is available when the
      // Desktop app was opened from a GUI with a minimal PATH.
      env: {
        PATH: launchPath
      },
      label: `installed dsh (${installed})`,
      source: 'installed'
    }
  }

  // Unsupported systems can still use an explicit or machine-installed dsh;
  // only the managed download is limited to release targets we publish.
  assertSupportedTarget(platform, arch)

  const runtimeVersion = cleanVersion(options.runtimeVersion, 'runtimeVersion')
  const desktopVersion = cleanVersion(options.desktopVersion, 'desktopVersion')
  const electronAbi = String(options.electronAbi || '').trim()
  if (!/^\d+$/.test(electronAbi)) throw new Error('electronAbi is required')
  const asset = runtimeAssetName({ version: runtimeVersion, platform, arch })
  const bin = managedRuntimeBin({
    userDataDir: options.userDataDir,
    version: runtimeVersion,
    platform,
    arch
  })
  const installDir = installDirForBin(bin)
  const execPath = options.execPath || process.execPath
  const report = typeof options.onProgress === 'function' ? options.onProgress : () => {}
  const expectedOverride = env.DSH_RUNTIME_SHA256
    ? parseChecksum(env.DSH_RUNTIME_SHA256, 'DSH_RUNTIME_SHA256')
    : null
  const context = {
    runtimeVersion,
    desktopVersion,
    electronAbi,
    platform,
    arch,
    asset,
    bin,
    installDir,
    execPath
  }

  if (await verifiedCache(context, expectedOverride)) {
    report({ phase: 'ready', label: `${RUNTIME_PACKAGE}@${runtimeVersion}` })
    return managedLaunch(context, 'managed-cache')
  }

  const fetchImpl = options.fetch || globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new Error('No fetch implementation is available to download the DSH runtime')
  }
  const defaultUrl = `https://github.com/${REPOSITORY}/releases/download/v${desktopVersion}/${asset}`
  const runtimeUrl = env.DSH_RUNTIME_URL || defaultUrl
  const stagingParent = path.dirname(installDir)
  await fsp.mkdir(stagingParent, { recursive: true })
  const stagingDir = await fsp.mkdtemp(path.join(stagingParent, '.staging-'))
  const archiveFile = path.join(stagingDir, asset)
  const payloadDir = path.join(stagingDir, 'payload')

  try {
    // Let the desktop app show its progress window before the first request.
    report({ phase: 'download', downloadedBytes: 0, label: asset })
    const expectedChecksum = expectedOverride || await remoteChecksum(fetchImpl, runtimeUrl)
    const actualChecksum = await downloadArchive(
      fetchImpl,
      runtimeUrl,
      archiveFile,
      report,
      asset
    )
    report({ phase: 'verify', label: asset })
    if (actualChecksum !== expectedChecksum) {
      throw new Error(
        `Runtime checksum mismatch for ${asset}: expected ${expectedChecksum}, got ${actualChecksum}`
      )
    }

    report({ phase: 'extract', label: asset })
    await fsp.mkdir(payloadDir)
    // tar is a direct production dependency so extraction works in packaged apps.
    const tar = require('tar')
    await tar.x({ file: archiveFile, cwd: payloadDir, strict: true })

    const { bin: stagedBin, packageFile } = await readRuntimePackage(payloadDir, runtimeVersion)
    const [binSha256, packageSha256] = await Promise.all([
      hashFile(stagedBin),
      hashFile(packageFile)
    ])
    await fsp.writeFile(
      path.join(payloadDir, '.verified.json'),
      JSON.stringify({
        schemaVersion: 2,
        runtimeVersion,
        desktopVersion,
        electronAbi,
        platform,
        arch,
        asset,
        checksum: actualChecksum,
        binSha256,
        packageSha256,
        verifiedAt: new Date().toISOString()
      }, null, 2) + '\n',
      { flag: 'wx' }
    )

    // The destination is app-owned. The final rename makes a complete runtime
    // appear at once; stale or invalid cache contents are only removed now.
    await fsp.rm(installDir, { recursive: true, force: true })
    await fsp.rename(payloadDir, installDir)
    report({ phase: 'ready', label: `${RUNTIME_PACKAGE}@${runtimeVersion}` })
    return managedLaunch(context, 'managed-download')
  } finally {
    await fsp.rm(stagingDir, { recursive: true, force: true })
  }
}

module.exports = {
  findInstalledDsh,
  runtimeAssetName,
  managedRuntimeBin,
  resolveRuntime
}
