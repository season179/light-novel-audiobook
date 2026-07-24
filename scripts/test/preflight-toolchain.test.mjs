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

test('accepts every current native Linux dependency family', () => {
  const markers = expectedNativeMarkers('x64')
  assert.deepEqual(markers, [
    '@biomejs+cli-linux-x64@',
    '@typescript+typescript-linux-x64@',
    '@rolldown+binding-linux-x64-gnu@',
    '@esbuild+linux-x64@',
    'lightningcss-linux-x64-gnu@',
  ])
  assert.deepEqual(
    dependencyTreeErrors(
      markers.map((marker) => `${marker}1.0.0`),
      'x64',
    ),
    [],
  )
})

test('reports mismatched and missing native dependencies clearly', () => {
  const entries = [
    ...expectedNativeMarkers('x64').map((marker) => `${marker}1.0.0`),
    '@biomejs+cli-win32-x64@2.5.5',
    '@esbuild+win32-x64@0.27.7',
    'lightningcss-win32-x64-msvc@1.33.0',
  ]
  const mismatches = dependencyTreeErrors(entries, 'x64')
  assert.ok(mismatches.some((error) => error.includes('@biomejs/cli')))
  assert.ok(mismatches.some((error) => error.includes('@esbuild')))
  assert.ok(mismatches.some((error) => error.includes('lightningcss')))

  const missing = dependencyTreeErrors([], 'x64')
  assert.ok(missing.some((error) => error.includes('@typescript+typescript-linux-x64@')))
  assert.ok(missing.some((error) => error.includes('@esbuild+linux-x64@')))
  assert.ok(missing.some((error) => error.includes('lightningcss-linux-x64-gnu@')))
})
