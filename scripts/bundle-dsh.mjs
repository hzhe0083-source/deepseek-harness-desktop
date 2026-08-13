#!/usr/bin/env node

// Build a complete, platform-native DeepSeek Harness runtime under vendor/dsh.
//
// Normal local builds resolve the official npm `latest` tag at build time. The
// release workflow first creates one ephemeral snapshot (exact DSH version +
// package-lock.json), then gives that same snapshot to the native macOS and
// Linux builders. Nothing in this repository needs a hand-maintained DSH pin.

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const localRequire = createRequire(import.meta.url)
const { isSuccessfulHtmlResponse } = localRequire('../main/http-safety')

const PACKAGE_NAME = '@deepseek-ai/dsh'
const scriptPath = fileURLToPath(import.meta.url)
const projectRoot = resolve(dirname(scriptPath), '..')
const vendorRoot = join(projectRoot, 'vendor')
const outDir = join(vendorRoot, 'dsh')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function fail (message) {
  throw new Error(`bundle-dsh: ${message}`)
}

function readJson (file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function writeJson (file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function run (command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || projectRoot,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeout || 10 * 60 * 1000,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = options.capture
      ? `\n${String(result.stdout || '')}${String(result.stderr || '')}`.trimEnd()
      : ''
    fail(`${command} ${args.join(' ')} exited with ${result.status}${detail}`)
  }
  return String(result.stdout || '').trim()
}

function sha256File (file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

export function normalizeNpmScalar (raw, label) {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
  if (Array.isArray(parsed)) {
    if (parsed.length !== 1) fail(`${label} resolved to more than one value`)
    return String(parsed[0])
  }
  if (parsed === null || parsed === undefined || typeof parsed === 'object') {
    fail(`${label} did not resolve to a scalar value`)
  }
  return String(parsed)
}

export function validateExactVersion (version) {
  // npm package versions may contain prerelease/build identifiers, but never
  // whitespace, URL syntax, or a dist-tag once they have been resolved.
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`npm returned an invalid exact DSH version: ${version}`)
  }
  return version
}

function resolveOfficialMetadata (requested = 'latest') {
  const version = validateExactVersion(normalizeNpmScalar(run(
    npmCommand,
    ['view', `${PACKAGE_NAME}@${requested}`, 'version', '--json'],
    { capture: true }
  ), 'version'))
  const integrity = normalizeNpmScalar(run(
    npmCommand,
    ['view', `${PACKAGE_NAME}@${version}`, 'dist.integrity', '--json'],
    { capture: true }
  ), 'integrity')
  if (!/^sha512-[A-Za-z0-9+/=]+$/.test(integrity)) {
    fail(`npm returned an invalid integrity value for ${PACKAGE_NAME}@${version}`)
  }
  return { requested, version, integrity }
}

export function validateSnapshot (snapshotDir, expectedVersion) {
  const packageFile = join(snapshotDir, 'package.json')
  const lockFile = join(snapshotDir, 'package-lock.json')
  const snapshotFile = join(snapshotDir, 'snapshot.json')
  if (!existsSync(packageFile) || !existsSync(lockFile) || !existsSync(snapshotFile)) {
    fail(`snapshot is incomplete: ${snapshotDir}`)
  }

  const packageJson = readJson(packageFile)
  const lock = readJson(lockFile)
  const snapshot = readJson(snapshotFile)
  const dependencyVersion = packageJson.dependencies && packageJson.dependencies[PACKAGE_NAME]
  const lockedDsh = lock.packages && lock.packages[`node_modules/${PACKAGE_NAME}`]
  const rootLock = lock.packages && lock.packages['']

  validateExactVersion(snapshot.version)
  if (snapshot.package !== PACKAGE_NAME || dependencyVersion !== snapshot.version) {
    fail('snapshot package.json does not pin the resolved DSH version')
  }
  if (!lockedDsh || lockedDsh.version !== snapshot.version) {
    fail('snapshot lockfile does not contain the resolved DSH version')
  }
  if (!rootLock || !rootLock.dependencies || rootLock.dependencies[PACKAGE_NAME] !== snapshot.version) {
    fail('snapshot lockfile root dependency does not match the resolved DSH version')
  }
  if (snapshot.integrity && lockedDsh.integrity !== snapshot.integrity) {
    fail('snapshot DSH integrity does not match npm metadata')
  }
  if (expectedVersion && snapshot.version !== expectedVersion) {
    fail(`snapshot has DSH ${snapshot.version}, expected ${expectedVersion}`)
  }
  if (snapshot.lockSha256 && snapshot.lockSha256 !== sha256File(lockFile)) {
    fail('snapshot package-lock.json checksum does not match snapshot.json')
  }
  return snapshot
}

function createSnapshot (destination, requested = 'latest') {
  const metadata = resolveOfficialMetadata(requested)
  mkdirSync(destination, { recursive: true })
  const existing = readdirSync(destination).filter((name) => name !== '.DS_Store')
  if (existing.length) fail(`snapshot destination is not empty: ${destination}`)
  writeJson(join(destination, 'package.json'), {
    name: 'deepseek-harness-runtime-snapshot',
    version: '0.0.0',
    private: true,
    dependencies: { [PACKAGE_NAME]: metadata.version }
  })
  run(npmCommand, [
    'install',
    '--package-lock-only',
    '--ignore-scripts',
    '--include=optional',
    '--no-audit',
    '--no-fund'
  ], { cwd: destination })

  const snapshot = {
    schemaVersion: 1,
    package: PACKAGE_NAME,
    requested: metadata.requested,
    version: metadata.version,
    integrity: metadata.integrity,
    resolvedAt: new Date().toISOString(),
    nodeVersion: process.version,
    npmVersion: run(npmCommand, ['--version'], { capture: true }),
    lockSha256: sha256File(join(destination, 'package-lock.json'))
  }
  writeJson(join(destination, 'snapshot.json'), snapshot)
  validateSnapshot(destination, metadata.version)
  return snapshot
}

function copySnapshot (source, destination) {
  mkdirSync(destination, { recursive: true })
  for (const name of ['package.json', 'package-lock.json', 'snapshot.json']) {
    cpSync(join(source, name), join(destination, name))
  }
}

function isDshPackage (dir) {
  return existsSync(join(dir, 'package.json')) &&
    existsSync(join(dir, 'lib', 'bin.js'))
}

function dshPackageDir (runtimeRoot) {
  return join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh')
}

function copyNpmPrefix (source, destination) {
  if (!existsSync(join(source, 'node_modules'))) fail(`npm prefix has no node_modules: ${source}`)
  cpSync(join(source, 'node_modules'), join(destination, 'node_modules'), {
    recursive: true,
    dereference: false
  })
  for (const name of ['package.json', 'package-lock.json', 'snapshot.json']) {
    const file = join(source, name)
    if (existsSync(file)) cpSync(file, join(destination, name))
  }
}

function copyDshPackageFiles (source, destination) {
  mkdirSync(destination, { recursive: true })
  for (const name of [
    'package.json',
    'lib',
    'config',
    'LICENSE',
    'README.md',
    'README.zh.md',
    'README.i18n.yaml'
  ]) {
    const file = join(source, name)
    if (!existsSync(file)) continue
    cpSync(file, join(destination, name), { recursive: true, dereference: false })
  }
}

function copyLocalRuntime (sourceInput, destination) {
  const source = resolve(sourceInput)
  const packageUnderRoot = dshPackageDir(source)
  if (isDshPackage(packageUnderRoot)) {
    // DSH_INSTALL_DIR may be an npm prefix containing credentials in .npmrc or
    // unrelated local files. Only copy the dependency tree and reproducibility
    // metadata we explicitly understand.
    copyNpmPrefix(source, destination)
    return
  }

  // Also accept a direct npm package path when its containing install prefix
  // still has the complete hoisted dependency tree.
  if (isDshPackage(source)) {
    const possiblePrefix = resolve(source, '..', '..', '..')
    if (resolve(dshPackageDir(possiblePrefix)) === source && existsSync(join(possiblePrefix, 'node_modules'))) {
      copyNpmPrefix(possiblePrefix, destination)
      return
    }

    // Compatibility with the old generated vendor/dsh layout: the DSH package
    // was at the root and its complete hoisted node_modules sat beside it.
    if (existsSync(join(source, 'node_modules'))) {
      mkdirSync(join(destination, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
      cpSync(join(source, 'node_modules'), join(destination, 'node_modules'), {
        recursive: true,
        dereference: false
      })
      copyDshPackageFiles(source, join(destination, 'node_modules', '@deepseek-ai', 'dsh'))
      return
    }
  }
  fail(`DSH_INSTALL_DIR is not a complete runtime: ${source}`)
}

function repairNativeHelpers (runtimeRoot) {
  const upstreamRepair = join(
    runtimeRoot,
    'node_modules',
    '@deepseek-ai',
    'dsh-subprocess-local',
    'scripts',
    'ensure-spawn-helper.mjs'
  )
  if (existsSync(upstreamRepair)) {
    run(process.execPath, [upstreamRepair], { cwd: runtimeRoot, capture: true, timeout: 60_000 })
  }
  const prebuilds = join(runtimeRoot, 'node_modules', 'node-pty', 'prebuilds')
  if (!existsSync(prebuilds)) return
  for (const platformDir of readdirSync(prebuilds)) {
    const helper = join(prebuilds, platformDir, 'spawn-helper')
    if (!existsSync(helper)) continue
    try { chmodSync(helper, 0o755) } catch {}
  }
}

function electronBinary () {
  const binary = localRequire('electron')
  if (typeof binary !== 'string' || !existsSync(binary)) {
    fail('local Electron binary is unavailable; run npm install first')
  }
  return binary
}

function validateInstalledRuntime (runtimeRoot, expectedVersion) {
  const packageDir = dshPackageDir(runtimeRoot)
  if (!isDshPackage(packageDir)) fail('installed runtime is missing the DSH CLI')

  const packageJson = readJson(join(packageDir, 'package.json'))
  validateExactVersion(packageJson.version)
  if (expectedVersion && packageJson.version !== expectedVersion) {
    fail(`installed DSH is ${packageJson.version}, expected ${expectedVersion}`)
  }

  const runtimeRequire = createRequire(join(packageDir, 'package.json'))
  for (const dependency of Object.keys(packageJson.dependencies || {})) {
    try {
      runtimeRequire.resolve(dependency)
    } catch (error) {
      fail(`installed runtime cannot resolve ${dependency}: ${error.message}`)
    }
  }

  // npm catches missing/invalid transitive packages before the much less
  // helpful runtime MODULE_NOT_FOUND error reaches an end user.
  if (existsSync(join(runtimeRoot, 'package-lock.json'))) {
    run(npmCommand, ['ls', '--all', '--omit=dev'], { cwd: runtimeRoot, capture: true })
  }

  const electron = electronBinary()
  const cli = join(packageDir, 'lib', 'bin.js')
  const electronEnv = { ELECTRON_RUN_AS_NODE: '1' }
  run(electron, ['--expose-internals', cli, '--help'], {
    capture: true,
    env: electronEnv,
    timeout: 60_000
  })
  run(electron, ['--expose-internals', cli, 'web', '--help'], {
    capture: true,
    env: electronEnv,
    timeout: 60_000
  })

  // Load native modules with Electron's embedded Node, not only the runner's
  // system Node. This rejects ABI-incompatible upstream updates before release.
  const nativePackages = [
    'node-pty',
    'sharp',
    'koffi',
    '@vscode/ripgrep',
    'node-addon-require-builtin',
    ...(process.platform === 'linux' ? ['@deepseek-ai/node-addon-landlock-run'] : [])
  ]
  const nativeProbe = [
    "const {createRequire}=require('node:module')",
    'const req=createRequire(process.argv[1])',
    `for (const name of ${JSON.stringify(nativePackages)}) {`,
    "  try { req.resolve(name) } catch (error) { if (error && error.code === 'MODULE_NOT_FOUND') continue; throw error }",
    '  req(name)',
    '}',
    "process.stdout.write('native runtime probe ok\\n')"
  ].join(';')
  run(electron, ['--expose-internals', '-e', nativeProbe, join(packageDir, 'package.json')], {
    capture: true,
    env: electronEnv,
    timeout: 60_000
  })
  if (process.platform === 'linux') {
    const landlockProbe = [
      "const {createRequire}=require('node:module');const req=createRequire(process.argv[1]);",
      "let found=true;try{req.resolve('@deepseek-ai/node-addon-landlock-run')}catch(error){if(error&&error.code==='MODULE_NOT_FOUND')found=false;else throw error}",
      "if(found){import('@deepseek-ai/node-addon-landlock-run').then(({launcherPath})=>{",
      " const fs=require('node:fs'); fs.accessSync(launcherPath(), fs.constants.R_OK | fs.constants.X_OK)",
      '}).catch((error)=>{console.error(error);process.exit(1)})}'
    ].join('')
    run(electron, ['--expose-internals', '-e', landlockProbe, join(packageDir, 'package.json')], {
      cwd: packageDir,
      capture: true,
      env: electronEnv,
      timeout: 60_000
    })
  }
  return packageJson.version
}

function findFreePort () {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
  })
}

async function smokeWebRuntime (runtimeRoot) {
  const port = await findFreePort()
  const cli = join(dshPackageDir(runtimeRoot), 'lib', 'bin.js')
  const smokeHome = mkdtempSync(join(tmpdir(), 'dsh-desktop-smoke-'))
  const child = spawn(electronBinary(), [
    '--expose-internals', cli, 'web', '--host', '127.0.0.1', '--port', String(port)
  ], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: smokeHome },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'ignore', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8000) })

  const stop = () => {
    try {
      if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM')
      else child.kill('SIGTERM')
    } catch {}
  }
  try {
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
      if (child.exitCode !== null) fail(`dsh web exited during smoke test (${child.exitCode})\n${stderr}`)
      const ready = await new Promise((resolveReady) => {
        const request = http.get(`http://127.0.0.1:${port}/`, (response) => {
          response.resume()
          resolveReady(isSuccessfulHtmlResponse(response.statusCode, response.headers['content-type']))
        })
        request.setTimeout(1000, () => { request.destroy(); resolveReady(false) })
        request.on('error', () => resolveReady(false))
      })
      if (ready) return
      await new Promise((resolveWait) => setTimeout(resolveWait, 250))
    }
    fail(`timed out waiting for dsh web smoke test\n${stderr}`)
  } finally {
    stop()
    if (child.exitCode === null) {
      await Promise.race([
        new Promise((resolveExit) => child.once('exit', resolveExit)),
        new Promise((resolveTimeout) => setTimeout(resolveTimeout, 3000))
      ])
    }
    if (child.exitCode === null) {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {}
    }
    rmSync(smokeHome, { recursive: true, force: true })
  }
}

function directoryBytes (dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name)
    if (entry.isDirectory()) total += directoryBytes(file)
    else if (entry.isFile()) total += statSync(file).size
  }
  return total
}

function replaceRuntime (candidate) {
  const backup = `${outDir}.backup-${process.pid}`
  rmSync(backup, { recursive: true, force: true })
  try {
    if (existsSync(outDir)) renameSync(outDir, backup)
    renameSync(candidate, outDir)
    rmSync(backup, { recursive: true, force: true })
  } catch (error) {
    if (!existsSync(outDir) && existsSync(backup)) renameSync(backup, outDir)
    throw error
  }
}

function validateRuntimeManifest (runtimeRoot) {
  const manifestFile = join(runtimeRoot, 'runtime-manifest.json')
  if (!existsSync(manifestFile)) fail('runtime-manifest.json is missing')
  const manifest = readJson(manifestFile)
  if (manifest.package !== PACKAGE_NAME) fail('runtime manifest has the wrong package name')
  validateExactVersion(manifest.version)
  if (manifest.platform !== process.platform || manifest.architecture !== process.arch) {
    fail(`runtime was assembled for ${manifest.platform}-${manifest.architecture}, not ${process.platform}-${process.arch}`)
  }
  const packageFile = join(dshPackageDir(runtimeRoot), 'package.json')
  if (manifest.packageSha256 !== sha256File(packageFile)) {
    fail('runtime DSH package checksum does not match its manifest')
  }
  const lockFile = join(runtimeRoot, 'package-lock.json')
  if (manifest.lockSha256 && (!existsSync(lockFile) || manifest.lockSha256 !== sha256File(lockFile))) {
    fail('runtime lockfile checksum does not match its manifest')
  }
  const electronVersion = readJson(join(projectRoot, 'node_modules', 'electron', 'package.json')).version
  if (manifest.electronVersion !== electronVersion) {
    fail(`runtime was verified for Electron ${manifest.electronVersion}, not ${electronVersion}`)
  }
  return manifest
}

async function assembleRuntime () {
  mkdirSync(vendorRoot, { recursive: true })
  const stage = mkdtempSync(join(vendorRoot, '.dsh-stage-'))
  let snapshot = null
  let source = 'official-npm'
  try {
    if (process.env.DSH_INSTALL_DIR) {
      source = 'local-override'
      copyLocalRuntime(process.env.DSH_INSTALL_DIR, stage)
    } else {
      const requested = process.env.DSH_VERSION || 'latest'
      const suppliedSnapshot = process.env.DSH_SNAPSHOT_DIR
      let snapshotDir = suppliedSnapshot && resolve(suppliedSnapshot)
      let temporarySnapshot = null
      if (!snapshotDir) {
        temporarySnapshot = mkdtempSync(join(tmpdir(), 'dsh-runtime-snapshot-'))
        snapshotDir = temporarySnapshot
        createSnapshot(snapshotDir, requested)
      }
      try {
        snapshot = validateSnapshot(snapshotDir, process.env.DSH_VERSION || undefined)
        copySnapshot(snapshotDir, stage)
        run(npmCommand, [
          'ci',
          '--omit=dev',
          '--include=optional',
          '--ignore-scripts=false',
          '--no-audit',
          '--no-fund'
        ], { cwd: stage })
        // A package-lock-only snapshot has nothing installed for npm to audit.
        // Verify registry provenance here, after the native dependency tree is
        // present and before any runtime is accepted for packaging.
        run(npmCommand, ['audit', 'signatures'], {
          cwd: stage,
          capture: true,
          timeout: 10 * 60 * 1000
        })
      } finally {
        if (temporarySnapshot) rmSync(temporarySnapshot, { recursive: true, force: true })
      }
    }

    repairNativeHelpers(stage)
    const version = validateInstalledRuntime(stage, snapshot && snapshot.version)
    await smokeWebRuntime(stage)
    const packageLock = join(stage, 'package-lock.json')
    const packageFile = join(dshPackageDir(stage), 'package.json')
    const embeddedNodeVersion = run(electronBinary(), ['-p', 'process.versions.node'], {
      capture: true,
      env: { ELECTRON_RUN_AS_NODE: '1' },
      timeout: 60_000
    })
    const manifest = {
      schemaVersion: 1,
      package: PACKAGE_NAME,
      requested: snapshot ? snapshot.requested : 'local-runtime',
      version,
      integrity: snapshot ? snapshot.integrity : null,
      lockSha256: existsSync(packageLock) ? sha256File(packageLock) : null,
      packageSha256: sha256File(packageFile),
      resolvedAt: snapshot ? snapshot.resolvedAt : null,
      assembledAt: new Date().toISOString(),
      source,
      platform: process.platform,
      architecture: process.arch,
      electronVersion: readJson(join(projectRoot, 'node_modules', 'electron', 'package.json')).version,
      embeddedNodeVersion,
      assemblerNodeVersion: process.version
    }
    writeJson(join(stage, 'runtime-manifest.json'), manifest)
    replaceRuntime(stage)
    const bytes = directoryBytes(outDir)
    console.log(`bundle ok: ${PACKAGE_NAME}@${version}, ${(bytes / 1024 / 1024).toFixed(1)} MB at ${outDir}`)
  } catch (error) {
    rmSync(stage, { recursive: true, force: true })
    throw error
  }
}

async function main () {
  const args = process.argv.slice(2)
  if (args[0] === '--print-version') {
    process.stdout.write(`${resolveOfficialMetadata(process.env.DSH_VERSION || 'latest').version}\n`)
    return
  }
  if (args[0] === '--prepare-snapshot') {
    if (!args[1]) fail('--prepare-snapshot requires a destination directory')
    const destination = resolve(args[1])
    mkdirSync(destination, { recursive: true })
    const snapshot = createSnapshot(destination, process.env.DSH_VERSION || 'latest')
    console.log(`snapshot ok: ${PACKAGE_NAME}@${snapshot.version} at ${destination}`)
    return
  }
  if (args[0] === '--verify-only') {
    accessSync(outDir)
    const manifest = validateRuntimeManifest(outDir)
    const version = validateInstalledRuntime(outDir, manifest.version)
    await smokeWebRuntime(outDir)
    console.log(`runtime verified: ${PACKAGE_NAME}@${version} (${process.platform}-${process.arch})`)
    return
  }
  if (args.length) fail(`unknown argument: ${args.join(' ')}`)
  await assembleRuntime()
}

if (resolve(process.argv[1] || '') === scriptPath) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error)
    process.exitCode = 1
  })
}
