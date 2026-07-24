import assert from 'node:assert/strict'
import test from 'node:test'
import {
  dependencyTreeErrors,
  expectedNativeMarkers,
  isMountedWindowsPath,
  parseVersion,
} from '../preflight-toolchain.mjs'

test('parses stable and prerelease tool versions', () => {
  assert.deepEqual(parseVersion('v24.18.0'), { major: 24, minor: 18, patch: 0 })
  assert.deepEqual(parseVersion('11.17.0'), { major: 11, minor: 17, patch: 0 })
  assert.deepEqual(parseVersion('7.0.0-dev.1'), { major: 7, minor: 0, patch: 0 })
  assert.equal(parseVersion('latest'), undefined)
})

test('identifies Windows tools exposed through WSL', () => {
  assert.equal(isMountedWindowsPath('/mnt/c/Program Files/nodejs/node.exe'), true)
  assert.equal(isMountedWindowsPath('C:\\Program Files\\nodejs\\node.exe'), true)
  assert.equal(isMountedWindowsPath('/home/user/.local/bin/node'), false)
})

test('accepts a complete native Linux dependency tree', () => {
  const entries = expectedNativeMarkers('x64').map((marker) => `${marker}1.0.0`)
  assert.deepEqual(dependencyTreeErrors(entries, 'x64'), [])
})

test('reports platform-mismatched and missing native dependencies clearly', () => {
  const errors = dependencyTreeErrors(['@biomejs+cli-win32-x64@2.5.5'], 'x64')
  assert.ok(errors.some((error) => error.includes('Windows native packages')))
  assert.ok(errors.some((error) => error.includes('@typescript+typescript-linux-x64@')))
})
