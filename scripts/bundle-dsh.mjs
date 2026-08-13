#!/usr/bin/env node
// bundle-dsh.mjs — copy a full DeepSeek Harness (DSH) install into vendor/dsh
// so the packaged desktop app ships with its own runtime and needs neither
// Node.js nor a dsh install on the target machine.
//
// Source resolution order:
//   1. DSH_INSTALL_DIR env var (path to the @deepseek-ai/dsh package dir)
//   2. `npm root -g`/node_modules/@deepseek-ai/dsh
//   3. ~/.nvm/versions/node/*/lib/node_modules/@deepseek-ai/dsh
//
// The copy is then trimmed of binaries for other platforms.

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'vendor', 'dsh')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function findCandidates () {
  const found = []
  if (process.env.DSH_INSTALL_DIR) found.push(process.env.DSH_INSTALL_DIR)
  try {
    const npmInvocation = process.platform === 'win32'
      ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `${npmCommand} root -g`]]
      : [npmCommand, ['root', '-g']]
    const g = spawnSync(npmInvocation[0], npmInvocation[1], { encoding: 'utf8' })
    if (g.status === 0) found.push(join(g.stdout.trim(), '@deepseek-ai', 'dsh'))
  } catch {}
  const nvmBase = join(homedir(), '.nvm', 'versions', 'node')
  if (existsSync(nvmBase)) {
    for (const v of readdirSync(nvmBase)) {
      found.push(join(nvmBase, v, 'lib', 'node_modules', '@deepseek-ai', 'dsh'))
    }
  }
  return found
}

function looksLikeDsh (dir) {
  return existsSync(join(dir, 'lib', 'bin.js')) &&
    existsSync(join(dir, 'config', 'agent-presets')) &&
    existsSync(join(dir, 'package.json'))
}

// --- resolve ----------------------------------------------------------------
let source = null
for (const candidate of findCandidates()) {
  if (candidate && looksLikeDsh(candidate)) { source = candidate; break }
}
if (!source) {
  console.error('bundle-dsh: no DSH install found. Install it (`npm i -g @deepseek-ai/dsh`) or set DSH_INSTALL_DIR.')
  process.exit(1)
}

// --- copy -------------------------------------------------------------------
rmSync(outDir, { recursive: true, force: true })
mkdirSync(dirname(outDir), { recursive: true })
console.log(`copying ${source} -> ${outDir}`)
cpSync(source, outDir, {
  recursive: true,
  dereference: false,
  filter: (src) => !/node_modules[\\/]\.bin($|[\\/])/.test(src)
})

// --- trim other-platform binaries -------------------------------------------
const trims = [
  ...(process.platform === 'win32'
    ? [
        ['node_modules', 'node-pty', 'prebuilds', 'darwin-x64'],
        ['node_modules', 'node-pty', 'prebuilds', 'darwin-arm64'],
        ['node_modules', '@img', 'sharp-linuxmusl-x64'],
        ['node_modules', '@img', 'sharp-libvips-linuxmusl-x64'],
        ['node_modules', '@img', 'sharp-wasm32']
      ]
    : [
        ['node_modules', 'node-pty', 'prebuilds', 'win32-x64'],
        ['node_modules', 'node-pty', 'prebuilds', 'win32-arm64'],
        ['node_modules', 'node-pty', 'prebuilds', 'darwin-x64'],
        ['node_modules', 'node-pty', 'prebuilds', 'darwin-arm64'],
        ['node_modules', '@img', 'sharp-linuxmusl-x64'],
        ['node_modules', '@img', 'sharp-libvips-linuxmusl-x64'],
        ['node_modules', '@img', 'sharp-wasm32']
      ])
]

for (const parts of trims) {
  const target = join(outDir, ...parts)
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true })
    console.log(`trimmed ${parts.join('/')}`)
  }
}

// --- report -----------------------------------------------------------------
function du (dir) {
  let total = 0
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.isFile()) total += statSync(p).size
    }
  }
  walk(dir)
  return total
}
const bytes = du(outDir)
const bin = join(outDir, 'lib', 'bin.js')
if (!existsSync(bin)) {
  console.error('bundle-dsh: copied tree is missing lib/bin.js — aborting')
  process.exit(1)
}
console.log(`bundle ok: ${(bytes / 1024 / 1024).toFixed(1)} MB at ${outDir}`)
