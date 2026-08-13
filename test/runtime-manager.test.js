'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const tar = require('tar')

const {
  findInstalledDsh,
  managedRuntimeBin,
  resolveRuntime,
  runtimeAssetName
} = require('../main/runtime-manager')

const RUNTIME_VERSION = '0.1.0-rc.6'
const DESKTOP_VERSION = '0.5.0'
const ELECTRON_ABI = '145'

async function temporaryDirectory (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-runtime-test-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

function sha256 (value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function installDir (bin) {
  return path.dirname(path.dirname(path.dirname(bin)))
}

async function createVerifiedCache (userDataDir) {
  const bin = managedRuntimeBin({
    userDataDir,
    version: RUNTIME_VERSION,
    platform: 'linux',
    arch: 'x64'
  })
  const root = installDir(bin)
  const packageFile = path.join(root, 'dsh', 'package.json')
  const binContents = '#!/usr/bin/env node\nconsole.log("cached")\n'
  const packageContents = JSON.stringify({
    name: '@deepseek-ai/dsh',
    version: RUNTIME_VERSION
  }) + '\n'

  await fs.mkdir(path.dirname(bin), { recursive: true })
  await fs.writeFile(bin, binContents)
  await fs.writeFile(packageFile, packageContents)
  await fs.writeFile(path.join(root, '.verified.json'), JSON.stringify({
    schemaVersion: 2,
    runtimeVersion: RUNTIME_VERSION,
    desktopVersion: DESKTOP_VERSION,
    electronAbi: ELECTRON_ABI,
    platform: 'linux',
    arch: 'x64',
    asset: runtimeAssetName({
      version: RUNTIME_VERSION,
      platform: 'linux',
      arch: 'x64'
    }),
    checksum: 'a'.repeat(64),
    binSha256: sha256(binContents),
    packageSha256: sha256(packageContents)
  }))
  return bin
}

async function createRuntimeArchive (root) {
  const payload = path.join(root, 'archive-payload')
  const bin = path.join(payload, 'dsh', 'lib', 'bin.js')
  await fs.mkdir(path.dirname(bin), { recursive: true })
  await fs.writeFile(bin, '#!/usr/bin/env node\nconsole.log("downloaded")\n')
  await fs.writeFile(path.join(payload, 'dsh', 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh',
    version: RUNTIME_VERSION
  }) + '\n')

  const archive = path.join(root, 'runtime.tar.gz')
  await tar.c({ cwd: payload, file: archive, gzip: true, portable: true }, ['dsh'])
  const bytes = await fs.readFile(archive)
  return { bytes, checksum: sha256(bytes) }
}

async function runtimeServer (t, archive, checksum) {
  const server = http.createServer((request, response) => {
    if (request.url.endsWith('.sha256')) {
      response.end(`${checksum}  runtime.tar.gz\n`)
      return
    }
    response.setHeader('content-length', archive.length)
    response.end(archive)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const { port } = server.address()
  return `http://127.0.0.1:${port}/runtime.tar.gz`
}

function baseOptions (root, env = {}) {
  return {
    userDataDir: path.join(root, 'user-data'),
    desktopVersion: DESKTOP_VERSION,
    runtimeVersion: RUNTIME_VERSION,
    electronAbi: ELECTRON_ABI,
    execPath: '/opt/DeepSeek Harness/deepseek-harness-desktop',
    env: { PATH: '', HOME: root, ...env },
    homedir: root,
    platform: 'linux',
    arch: 'x64'
  }
}

test('asset naming, cache path, and installed lookup are deterministic', async (t) => {
  const root = await temporaryDirectory(t)
  const binDir = path.join(root, 'bin')
  const installed = path.join(binDir, 'dsh')
  await fs.mkdir(binDir)
  await fs.writeFile(installed, '#!/bin/sh\n', { mode: 0o755 })

  assert.equal(
    runtimeAssetName({ version: RUNTIME_VERSION, platform: 'linux', arch: 'arm64' }),
    `dsh-runtime-${RUNTIME_VERSION}-linux-arm64.tar.gz`
  )
  assert.equal(
    managedRuntimeBin({
      userDataDir: root,
      version: RUNTIME_VERSION,
      platform: 'darwin',
      arch: 'arm64'
    }),
    path.join(root, 'runtime', RUNTIME_VERSION, 'darwin-arm64', 'dsh', 'lib', 'bin.js')
  )
  assert.equal(findInstalledDsh({ env: { PATH: binDir }, homedir: root }), installed)
  assert.throws(
    () => runtimeAssetName({ version: RUNTIME_VERSION, platform: 'win32', arch: 'x64' }),
    /Unsupported DSH runtime target: win32-x64/
  )

  const winHome = path.join(root, 'win-home')
  const winNpm = path.join(winHome, 'AppData', 'Roaming', 'npm')
  const winCmd = path.join(winNpm, 'dsh.cmd')
  await fs.mkdir(winNpm, { recursive: true })
  await fs.writeFile(winCmd, '@echo off\r\n', { mode: 0o755 })
  assert.equal(
    findInstalledDsh({
      platform: 'win32',
      homedir: winHome,
      env: { PATH: '', APPDATA: path.join(winHome, 'AppData', 'Roaming') }
    }),
    winCmd
  )
})

test('resolution priority is DSH_BIN, installed dsh, then verified cache', async (t) => {
  const root = await temporaryDirectory(t)
  const options = baseOptions(root)
  const systemBinDir = path.join(root, 'system-bin')
  const systemDsh = path.join(systemBinDir, 'dsh')
  await fs.mkdir(systemBinDir)
  await fs.writeFile(systemDsh, '#!/bin/sh\n', { mode: 0o755 })
  const cachedBin = await createVerifiedCache(options.userDataDir)
  let fetchCalls = 0
  const failFetch = async () => {
    fetchCalls++
    throw new Error('fetch must not run')
  }

  const explicit = await resolveRuntime({
    ...options,
    env: { ...options.env, PATH: systemBinDir, DSH_BIN: '/custom/dsh' },
    fetch: failFetch
  })
  assert.deepEqual(explicit, {
    command: '/custom/dsh',
    prefixArgs: [],
    env: {},
    label: 'DSH_BIN (/custom/dsh)',
    source: 'env'
  })

  const explicitOnUnsupportedTarget = await resolveRuntime({
    ...options,
    platform: 'win32',
    arch: 'x64',
    env: { ...options.env, DSH_BIN: 'C:\\tools\\dsh.cmd' },
    fetch: failFetch
  })
  assert.equal(explicitOnUnsupportedTarget.command, 'C:\\tools\\dsh.cmd')
  assert.equal(explicitOnUnsupportedTarget.source, 'env')

  const installed = await resolveRuntime({
    ...options,
    env: { ...options.env, PATH: systemBinDir },
    fetch: failFetch
  })
  assert.equal(installed.command, systemDsh)
  assert.equal(installed.env.PATH, systemBinDir)
  assert.equal(installed.source, 'installed')

  const cached = await resolveRuntime({ ...options, fetch: failFetch })
  assert.equal(cached.command, options.execPath)
  assert.deepEqual(cached.prefixArgs, ['--expose-internals', cachedBin])
  assert.deepEqual(cached.env, { ELECTRON_RUN_AS_NODE: '1' })
  assert.equal(cached.source, 'managed-cache')
  assert.equal(fetchCalls, 0)
})

test('checksum mismatch aborts without installing the runtime', async (t) => {
  const root = await temporaryDirectory(t)
  const archive = Buffer.from('not the expected runtime')
  const url = await runtimeServer(t, archive, '0'.repeat(64))
  const options = baseOptions(root, { DSH_RUNTIME_URL: url })
  const progress = []

  await assert.rejects(
    resolveRuntime({ ...options, onProgress: (event) => progress.push(event) }),
    /Runtime checksum mismatch/
  )
  await assert.rejects(fs.access(managedRuntimeBin({
    userDataDir: options.userDataDir,
    version: RUNTIME_VERSION,
    platform: 'linux',
    arch: 'x64'
  })))
  assert.ok(progress.some(({ phase }) => phase === 'download'))
  assert.ok(progress.some(({ phase }) => phase === 'verify'))
  assert.ok(!progress.some(({ phase }) => phase === 'extract'))
})

test('managed cache is invalidated when the Desktop release or Electron ABI changes', async (t) => {
  const root = await temporaryDirectory(t)
  const options = baseOptions(root)
  await createVerifiedCache(options.userDataDir)
  let fetchCalls = 0
  const unavailable = async () => {
    fetchCalls++
    throw new Error('download required')
  }

  await assert.rejects(
    resolveRuntime({ ...options, electronAbi: '146', fetch: unavailable }),
    /download required/
  )
  await assert.rejects(
    resolveRuntime({ ...options, desktopVersion: '0.5.1', fetch: unavailable }),
    /download required/
  )
  assert.equal(fetchCalls, 2)
})

test('a valid archive is verified, extracted, marked, and launched with Electron', async (t) => {
  const root = await temporaryDirectory(t)
  const { bytes, checksum } = await createRuntimeArchive(root)
  const url = await runtimeServer(t, bytes, checksum)
  const options = baseOptions(root, { DSH_RUNTIME_URL: url })
  const progress = []

  const result = await resolveRuntime({
    ...options,
    onProgress: (event) => progress.push(event)
  })
  const bin = managedRuntimeBin({
    userDataDir: options.userDataDir,
    version: RUNTIME_VERSION,
    platform: 'linux',
    arch: 'x64'
  })
  assert.equal(result.command, options.execPath)
  assert.deepEqual(result.prefixArgs, ['--expose-internals', bin])
  assert.deepEqual(result.env, { ELECTRON_RUN_AS_NODE: '1' })
  assert.equal(result.source, 'managed-download')
  assert.match(await fs.readFile(bin, 'utf8'), /downloaded/)

  const marker = JSON.parse(await fs.readFile(path.join(installDir(bin), '.verified.json'), 'utf8'))
  assert.equal(marker.runtimeVersion, RUNTIME_VERSION)
  assert.equal(marker.desktopVersion, DESKTOP_VERSION)
  assert.equal(marker.electronAbi, ELECTRON_ABI)
  assert.equal(marker.platform, 'linux')
  assert.equal(marker.arch, 'x64')
  assert.equal(marker.checksum, checksum)
  assert.deepEqual(
    [...new Set(progress.map(({ phase }) => phase))],
    ['download', 'verify', 'extract', 'ready']
  )
  assert.ok(progress.every((event) => event && typeof event === 'object'))
})
