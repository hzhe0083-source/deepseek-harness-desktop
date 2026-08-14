'use strict'

const { spawnSync } = require('node:child_process')

// Windows tree termination for the dsh server.
//
// The launched command is often only an intermediate process: a .cmd/.bat
// shim spawns the real node.exe server as a grandchild, and dsh itself may
// spawn further helpers. `proc.kill()` terminates only the direct child, so
// closing the window used to leave the node.exe server running in the
// background. `taskkill /T /F` terminates the whole tree instead.

/**
 * Terminate a process and all of its descendants on Windows.
 *
 * Returns true when taskkill reports the tree terminated (exit code 0) or
 * already gone (exit code 128). Returns false on non-Windows platforms, for
 * invalid pids, or when taskkill fails (the caller should then fall back to
 * killing the direct child).
 *
 * @param {number} pid
 * @param {object} [options]
 * @param {string} [options.platform] - override `process.platform` for tests
 * @param {Function} [options.spawnSync] - injectable spawnSync for tests
 * @param {number} [options.timeout]
 * @returns {boolean}
 */
function terminateProcessTree (pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if ((options.platform || process.platform) !== 'win32') return false

  const spawnImpl = options.spawnSync || spawnSync
  let result
  try {
    result = spawnImpl('taskkill', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: options.timeout || 15000
    })
  } catch {
    return false
  }
  if (!result) return false
  // 0 = terminated, 128 = no such process (the tree is already gone).
  return result.status === 0 || result.status === 128
}

module.exports = { terminateProcessTree }
