import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  normalizeNpmScalar,
  validateExactVersion,
  validateSnapshot
} from '../scripts/bundle-dsh.mjs'

function writeJson (file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

test('npm metadata is reduced to one concrete version', () => {
  assert.equal(normalizeNpmScalar('"7.8.9-rc.2"', 'version'), '7.8.9-rc.2')
  assert.equal(normalizeNpmScalar(['0.1.0'], 'version'), '0.1.0')
  assert.throws(() => normalizeNpmScalar(['0.1.0', '0.2.0'], 'version'), /more than one/)
  assert.equal(validateExactVersion('12.34.56-beta.7'), '12.34.56-beta.7')
  assert.throws(() => validateExactVersion('latest'), /invalid exact/)
  assert.throws(() => validateExactVersion('1.2.3; echo unsafe'), /invalid exact/)
})

test('a release snapshot requires one exact DSH package and matching integrity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-snapshot-unit-'))
  try {
    writeJson(join(dir, 'package.json'), {
      dependencies: { '@deepseek-ai/dsh': '1.2.3-rc.1' }
    })
    writeJson(join(dir, 'package-lock.json'), {
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { '@deepseek-ai/dsh': '1.2.3-rc.1' } },
        'node_modules/@deepseek-ai/dsh': {
          version: '1.2.3-rc.1',
          integrity: 'sha512-YWJjZA=='
        }
      }
    })
    writeJson(join(dir, 'snapshot.json'), {
      package: '@deepseek-ai/dsh',
      version: '1.2.3-rc.1',
      integrity: 'sha512-YWJjZA=='
    })

    assert.equal(validateSnapshot(dir, '1.2.3-rc.1').version, '1.2.3-rc.1')
    assert.throws(() => validateSnapshot(dir, '1.2.4'), /expected 1.2.4/)

    const snapshot = {
      package: '@deepseek-ai/dsh',
      version: '1.2.3-rc.1',
      integrity: 'sha512-ZGlmZmVyZW50'
    }
    writeJson(join(dir, 'snapshot.json'), snapshot)
    assert.throws(() => validateSnapshot(dir), /integrity/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
