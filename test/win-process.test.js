'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const test = require('node:test')

const { terminateProcessTree } = require('../main/win-process')

const winOnly = process.platform === 'win32' ? {} : { skip: 'taskkill only exists on Windows' }

function isAlive (pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

function waitFor (predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve()
      if (Date.now() > deadline) return reject(new Error(`condition not met within ${timeoutMs} ms`))
      setTimeout(tick, 50)
    }
    tick()
  })
}

test('refuses invalid pids and non-Windows platforms', () => {
  assert.equal(terminateProcessTree(0), false)
  assert.equal(terminateProcessTree(-1), false)
  assert.equal(terminateProcessTree(1.5), false)
  assert.equal(terminateProcessTree('123'), false)
  assert.equal(terminateProcessTree(123, { platform: 'linux' }), false)
  assert.equal(terminateProcessTree(123, { platform: 'darwin' }), false)
})

test('delegates to taskkill /T /F and treats 0/128 as success', () => {
  const calls = []
  const record = (command, args, options) => {
    calls.push({ command, args, options })
    return { status: 0 }
  }
  assert.equal(terminateProcessTree(4321, { platform: 'win32', spawnSync: record }), true)
  assert.deepEqual(calls, [{
    command: 'taskkill',
    args: ['/pid', '4321', '/T', '/F'],
    options: { windowsHide: true, stdio: 'ignore', timeout: 15000 }
  }])

  assert.equal(terminateProcessTree(1, { platform: 'win32', spawnSync: () => ({ status: 128 }) }), true)
  assert.equal(terminateProcessTree(1, { platform: 'win32', spawnSync: () => ({ status: 1 }) }), false)
  assert.equal(terminateProcessTree(1, { platform: 'win32', spawnSync: () => { throw new Error('blocked') } }), false)
  assert.equal(terminateProcessTree(1, { platform: 'win32', spawnSync: () => null }), false)
})

test('terminates a cmd.exe tree together with its node grandchild', winOnly, async (t) => {
  // Sandboxed or restricted environments can deny taskkill. Probe once with a
  // throwaway child so the test skips instead of failing there.
  const probe = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const probeKilled = terminateProcessTree(probe.pid)
  if (!probeKilled) {
    probe.kill('SIGKILL')
    t.skip('taskkill is not permitted in this environment')
    return
  }
  await waitFor(() => !isAlive(probe.pid), 5000)

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tree-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const pidFile = path.join(dir, 'grandchild.pid')
  const grandchildScript = path.join(dir, 'grandchild.js')
  fs.writeFileSync(grandchildScript, [
    `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
    'setInterval(() => {}, 1000)'
  ].join('\n'))
  const launcher = path.join(dir, 'dsh.cmd')
  fs.writeFileSync(launcher, `@echo off\r\nnode "${grandchildScript}"\r\n`)

  // Route the .cmd through a quoted cmd.exe /d /s /c line, the same way the
  // desktop shell launches .cmd launchers.
  const line = `"${launcher}"`
  const proc = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], {
    cwd: dir,
    stdio: 'ignore',
    windowsVerbatimArguments: true,
    windowsHide: true
  })
  t.after(() => { try { proc.kill('SIGKILL') } catch {} })

  await waitFor(() => fs.existsSync(pidFile))
  const grandchildPid = Number(fs.readFileSync(pidFile, 'utf8'))
  assert.equal(isAlive(grandchildPid), true, 'grandchild should be running before the kill')

  assert.equal(terminateProcessTree(proc.pid), true)
  await waitFor(() => !isAlive(grandchildPid))
  await waitFor(() => !isAlive(proc.pid), 5000)
})
