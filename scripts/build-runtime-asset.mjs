#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import * as tar from 'tar'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const desktopPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const runtimeProject = join(root, 'runtime')
const runtimePackage = JSON.parse(readFileSync(join(runtimeProject, 'package.json'), 'utf8'))
const runtimeVersion = process.env.DSH_RUNTIME_VERSION || desktopPackage.deepseekHarness?.runtimeVersion
const platform = process.platform
const arch = process.arch
const supported = new Set(['linux-x64', 'linux-arm64', 'darwin-arm64'])
const target = `${platform}-${arch}`

if (!runtimeVersion) throw new Error('package.json must define deepseekHarness.runtimeVersion')
if (runtimePackage.dependencies?.['@deepseek-ai/dsh'] !== runtimeVersion) {
  throw new Error('runtime/package.json must pin the same @deepseek-ai/dsh version as deepseekHarness.runtimeVersion')
}
if (!supported.has(target)) {
  throw new Error(`runtime assets support linux-x64, linux-arm64, and darwin-arm64; current host is ${target}`)
}

const outputDir = resolve(process.env.DSH_RUNTIME_OUTPUT_DIR || join(root, 'dist', 'runtime'))
const assetName = `dsh-runtime-${runtimeVersion}-${platform}-${arch}.tar.gz`
const workRoot = mkdtempSync(join(tmpdir(), 'dsh-desktop-runtime-'))

function packageIsExpected (candidate) {
  try {
    const manifest = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8'))
    return manifest.name === '@deepseek-ai/dsh' &&
      manifest.version === runtimeVersion &&
      existsSync(join(candidate, 'lib', 'bin.js')) &&
      existsSync(join(candidate, 'config', 'agent-presets'))
  } catch {
    return false
  }
}

function installRuntime () {
  const installRoot = join(workRoot, 'install')
  mkdirSync(installRoot)
  cpSync(join(runtimeProject, 'package.json'), join(installRoot, 'package.json'))
  cpSync(join(runtimeProject, 'package-lock.json'), join(installRoot, 'package-lock.json'))
  const result = spawnSync(
    'npm',
    ['ci', '--omit=dev', '--no-audit', '--no-fund'],
    { cwd: installRoot, stdio: 'inherit' }
  )
  if (result.status !== 0) throw new Error(`npm ci failed for @deepseek-ai/dsh@${runtimeVersion}`)

  const rebuild = spawnSync(
    join(root, 'node_modules', '.bin', 'electron-rebuild'),
    [
      '--version', desktopPackage.devDependencies.electron,
      '--module-dir', installRoot,
      '--force',
      '--only', 'node-pty',
      '--build-from-source',
      '--arch', arch,
      '--platform', platform
    ],
    { cwd: root, stdio: 'inherit' }
  )
  if (rebuild.status !== 0) {
    throw new Error(`electron-rebuild failed for node-pty (${platform}-${arch})`)
  }

  const electronPath = require('electron')
  const nativeCheck = spawnSync(
    electronPath,
    ['-e', `require(${JSON.stringify(join(installRoot, 'node_modules', 'node-pty'))})`],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8'
    }
  )
  if (nativeCheck.status !== 0) {
    throw new Error(`Electron could not load the rebuilt node-pty: ${nativeCheck.stderr || nativeCheck.stdout}`)
  }

  return {
    source: join(installRoot, 'node_modules', '@deepseek-ai', 'dsh'),
    nodeModules: join(installRoot, 'node_modules')
  }
}

function installedDependency (archiveRoot, dshDir, ...parts) {
  const nested = join(dshDir, 'node_modules', ...parts)
  return existsSync(nested) ? nested : join(archiveRoot, 'node_modules', ...parts)
}

function pruneRuntime (archiveRoot, dshDir) {
  const nodePty = installedDependency(archiveRoot, dshDir, 'node-pty')
  const prebuilds = join(nodePty, 'prebuilds')
  if (platform === 'linux') {
    rmSync(prebuilds, { recursive: true, force: true })
    if (!existsSync(join(nodePty, 'build', 'Release', 'pty.node'))) {
      throw new Error('Linux runtime is missing node-pty/build/Release/pty.node')
    }
  } else {
    for (const entry of existsSync(prebuilds) ? readdirSync(prebuilds) : []) {
      if (entry !== 'darwin-arm64') {
        rmSync(join(prebuilds, entry), { recursive: true, force: true })
      }
    }
    const compiled = join(nodePty, 'build', 'Release', 'pty.node')
    const prebuilt = join(prebuilds, 'darwin-arm64', 'pty.node')
    if (!existsSync(compiled) && !existsSync(prebuilt)) {
      throw new Error('macOS runtime is missing a darwin-arm64 node-pty binary')
    }
  }

  const sharpTarget = `${platform === 'darwin' ? 'darwin' : 'linux'}-${arch}`
  const imgDir = installedDependency(archiveRoot, dshDir, '@img')
  const keep = new Set([`sharp-${sharpTarget}`, `sharp-libvips-${sharpTarget}`])
  for (const entry of existsSync(imgDir) ? readdirSync(imgDir) : []) {
    if (entry.startsWith('sharp-') && !keep.has(entry)) {
      rmSync(join(imgDir, entry), { recursive: true, force: true })
    }
  }
  for (const entry of keep) {
    if (!existsSync(join(imgDir, entry, 'package.json'))) {
      throw new Error(`runtime is missing @img/${entry}`)
    }
  }
}

async function auditArchive (assetPath) {
  const entries = []
  await tar.list({
    file: assetPath,
    onentry: entry => entries.push({ path: entry.path, type: entry.type })
  })
  const allowedPath = value => value.startsWith('dsh/') || value.startsWith('node_modules/')
  if (entries.length === 0 || entries.some(entry => !allowedPath(entry.path))) {
    throw new Error('runtime archive must contain only dsh/ and node_modules/')
  }
  if (entries.some(entry => entry.type === 'SymbolicLink' || entry.type === 'Link')) {
    throw new Error('runtime archive must not contain links')
  }
  const unsafe = entries.find(entry => {
    const normalized = entry.path.replace(/\\/g, '/')
    return normalized.startsWith('/') || normalized.split('/').includes('..')
  })
  if (unsafe) throw new Error(`runtime archive contains an unsafe path: ${unsafe.path}`)
  const unexpected = entries.find(entry => {
    if (platform === 'linux' && entry.path.includes('node-pty/prebuilds/')) return true
    if (platform === 'darwin') {
      const target = entry.path.match(/node-pty\/prebuilds\/([^/]+)/)?.[1]
      if (target && target !== 'darwin-arm64') return true
    }
    const foreignSharp = platform === 'linux'
      ? /@img\/sharp-(?:wasm32|darwin|win32)|@img\/sharp-libvips-(?:darwin|win32)/
      : /@img\/sharp-(?:wasm32|linux|win32)|@img\/sharp-libvips-(?:linux|win32)/
    return foreignSharp.test(entry.path)
  })
  if (unexpected) throw new Error(`runtime archive contains an unexpected target: ${unexpected.path}`)
}

try {
  const { source, nodeModules } = installRuntime()
  if (!packageIsExpected(source)) {
    throw new Error(`${source} is not a complete @deepseek-ai/dsh@${runtimeVersion} installation`)
  }

  const archiveRoot = join(workRoot, 'archive')
  const copied = join(archiveRoot, 'dsh')
  mkdirSync(archiveRoot, { recursive: true })
  cpSync(source, copied, {
    recursive: true,
    dereference: true,
    filter: path => !/node_modules[\\/]\.bin(?:[\\/]|$)/.test(path)
  })
  const copiedNodeModules = join(archiveRoot, 'node_modules')
  const installedDsh = join(nodeModules, '@deepseek-ai', 'dsh')
  cpSync(nodeModules, copiedNodeModules, {
    recursive: true,
    dereference: true,
    filter: value => value !== installedDsh && !/node_modules[\\/]\.bin(?:[\\/]|$)/.test(value)
  })
  pruneRuntime(archiveRoot, copied)

  mkdirSync(outputDir, { recursive: true })
  const assetPath = join(outputDir, assetName)
  await tar.create({
    cwd: archiveRoot,
    file: assetPath,
    gzip: true,
    portable: true
  }, ['dsh', 'node_modules'])
  await auditArchive(assetPath)

  const bytes = readFileSync(assetPath)
  const digest = createHash('sha256').update(bytes).digest('hex')
  writeFileSync(`${assetPath}.sha256`, `${digest}  ${assetName}\n`)
  const sizeMiB = (statSync(assetPath).size / 1024 / 1024).toFixed(1)
  console.log(`runtime asset: ${assetPath} (${sizeMiB} MiB)`)
  console.log(`sha256: ${digest}`)
} finally {
  rmSync(workRoot, { recursive: true, force: true })
}
