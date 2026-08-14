'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const {
  buildWindowsCommand,
  isWindowsScriptCommand,
  quoteCmdArg
} = require('../main/win-command')

const winOnly = process.platform === 'win32' ? {} : { skip: 'requires cmd.exe on Windows' }

test('detects .cmd/.bat launchers case-insensitively', () => {
  assert.equal(isWindowsScriptCommand('C:\\tools\\dsh.CMD'), true)
  assert.equal(isWindowsScriptCommand('C:\\tools\\dsh.bat'), true)
  assert.equal(isWindowsScriptCommand('C:\\tools\\dsh.exe'), false)
  assert.equal(isWindowsScriptCommand('/usr/bin/dsh'), false)
  assert.equal(isWindowsScriptCommand(''), false)
  assert.equal(isWindowsScriptCommand(null), false)
  assert.equal(isWindowsScriptCommand(undefined), false)
})

test('quotes arguments CRT-style for cmd.exe', () => {
  assert.equal(quoteCmdArg('web'), 'web')
  assert.equal(quoteCmdArg('two words'), '"two words"')
  assert.equal(quoteCmdArg(''), '""')
  assert.equal(quoteCmdArg('trailing\\'), 'trailing\\')
  assert.equal(quoteCmdArg('dir space\\'), '"dir space\\\\"')
  assert.equal(quoteCmdArg('say "hi"'), '"say \\"hi\\""')
})

test('non-script commands pass through unchanged', () => {
  assert.deepEqual(buildWindowsCommand('C:\\tools\\dsh.exe', ['web']), {
    command: 'C:\\tools\\dsh.exe',
    args: ['web'],
    windowsVerbatimArguments: false
  })
})

test('script commands become a quoted cmd.exe /d /s /c line on Windows', () => {
  const target = buildWindowsCommand('C:\\Program Files\\nodejs\\dsh.cmd', ['web', '--port', '43127'], { platform: 'win32' })
  assert.equal(target.command, process.env.ComSpec || 'cmd.exe')
  assert.equal(target.windowsVerbatimArguments, true)
  assert.deepEqual(target.args, [
    '/d',
    '/s',
    '/c',
    '""C:\\Program Files\\nodejs\\dsh.cmd" web --port 43127"'
  ])
})

test('script-named commands pass through on non-Windows platforms', () => {
  // shell:true was only ever applied on Windows; a .cmd-named launcher on
  // Linux/macOS must keep running through the default shell, not cmd.exe.
  for (const platform of ['linux', 'darwin']) {
    assert.deepEqual(buildWindowsCommand('/opt/tools/dsh.cmd', ['web'], { platform }), {
      command: '/opt/tools/dsh.cmd',
      args: ['web'],
      windowsVerbatimArguments: false
    })
  }
})

test('a .cmd launcher in a path with spaces receives its arguments intact', winOnly, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-win-cmd '))
  try {
    const launcher = path.join(dir, 'dsh.cmd')
    fs.writeFileSync(launcher, '@echo off\r\necho %*>received.txt\r\n')

    const target = buildWindowsCommand(launcher, ['web', '--name', 'two words', ''])
    const result = spawnSync(target.command, target.args, {
      cwd: dir,
      stdio: 'ignore',
      windowsVerbatimArguments: target.windowsVerbatimArguments,
      windowsHide: true,
      timeout: 10000
    })
    assert.equal(result.status, 0)

    const received = fs.readFileSync(path.join(dir, 'received.txt'), 'utf8').trim()
    assert.equal(received, 'web --name "two words" ""')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
