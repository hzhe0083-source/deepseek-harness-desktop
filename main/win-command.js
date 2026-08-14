'use strict'

// Building Windows command lines for .cmd/.bat launchers.
//
// Node's `shell: true` joins the command and its arguments into one string,
// wraps the whole line in a single pair of quotes, and hands it to
// `cmd.exe /d /s /c "<line>"`. When the launcher path itself contains spaces
// (for example npm shims installed under `C:\Program Files\nodejs\`), the
// cmd.exe /s rule strips the first and last quote characters of that line,
// leaving the path unquoted and failing with
// `'C:\Program' is not recognized as an internal or external command`.
//
// Instead we quote every argument CRT-style, wrap the completed line in one
// outer pair of quotes, and pass it verbatim (`windowsVerbatimArguments`) to
// `cmd.exe /d /s /c`. The /s rule then strips the outer pair and leaves each
// individual argument intact.

function isWindowsScriptCommand (command) {
  return typeof command === 'string' && /\.(cmd|bat)$/i.test(command)
}

function quoteCmdArg (arg) {
  const value = String(arg)
  if (value === '') return '""'
  if (!/[\s"]/.test(value)) return value
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`
}

/**
 * Build a spawn() target for launching `command` with `args` on Windows.
 *
 * .cmd/.bat launchers are routed through a quoted `cmd.exe /d /s /c` line
 * so paths with spaces survive cmd's /s quote-stripping; every other command
 * passes through unchanged. On non-Windows platforms everything passes
 * through, matching the previous `shell: true` behaviour which only ever
 * applied to Windows.
 *
 * @param {string} command
 * @param {string[]} [args]
 * @param {object} [options]
 * @param {string} [options.platform] - override `process.platform` for tests
 * @returns {{ command: string, args: string[], windowsVerbatimArguments: boolean }}
 */
function buildWindowsCommand (command, args, options = {}) {
  const platform = options.platform || process.platform
  if (platform !== 'win32' || !isWindowsScriptCommand(command)) {
    return { command, args: args || [], windowsVerbatimArguments: false }
  }
  const line = `"${[command, ...(args || [])].map(quoteCmdArg).join(' ')}"`
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', line],
    windowsVerbatimArguments: true
  }
}

module.exports = {
  buildWindowsCommand,
  isWindowsScriptCommand,
  quoteCmdArg
}
