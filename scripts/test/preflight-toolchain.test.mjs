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
  assert.equal(isMountedWindowsPath('/Users/season/.nvm/versions/node/v24.18.0/bin/node'), false)
})

test('accepts every current native Linux x64 dependency family', () => {
  const markers = expectedNativeMarkers('linux', 'x64')
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
      'linux',
      'x64',
    ),
    [],
  )
})

test('accepts every current native Linux arm64 dependency family for both libc flavors', () => {
  assert.deepEqual(expectedNativeMarkers('linux', 'arm64', 'gnu'), [
    '@biomejs+cli-linux-arm64@',
    '@typescript+typescript-linux-arm64@',
    '@rolldown+binding-linux-arm64-gnu@',
    '@esbuild+linux-arm64@',
    'lightningcss-linux-arm64-gnu@',
  ])
  assert.deepEqual(expectedNativeMarkers('linux', 'arm64', 'musl'), [
    '@biomejs+cli-linux-arm64-musl@',
    '@typescript+typescript-linux-arm64@',
    '@rolldown+binding-linux-arm64-musl@',
    '@esbuild+linux-arm64@',
    'lightningcss-linux-arm64-musl@',
  ])
})

test('accepts every current native Darwin arm64 dependency family, including native TypeScript', () => {
  const markers = expectedNativeMarkers('darwin', 'arm64')
  assert.deepEqual(markers, [
    '@biomejs+cli-darwin-arm64@',
    '@typescript+typescript-darwin-arm64@',
    '@rolldown+binding-darwin-arm64@',
    '@esbuild+darwin-arm64@',
    'lightningcss-darwin-arm64@',
  ])
  assert.deepEqual(
    dependencyTreeErrors(
      markers.map((marker) => `${marker}1.0.0`),
      'darwin',
      'arm64',
    ),
    [],
  )
})

test('reports mismatched and missing native Linux dependencies clearly', () => {
  const entries = [
    ...expectedNativeMarkers('linux', 'x64').map((marker) => `${marker}1.0.0`),
    '@biomejs+cli-win32-x64@2.5.5',
    '@esbuild+win32-x64@0.27.7',
    'lightningcss-win32-x64-msvc@1.33.0',
  ]
  const mismatches = dependencyTreeErrors(entries, 'linux', 'x64')
  assert.ok(mismatches.some((error) => error.includes('@biomejs/cli')))
  assert.ok(mismatches.some((error) => error.includes('@esbuild')))
  assert.ok(mismatches.some((error) => error.includes('lightningcss')))

  const missing = dependencyTreeErrors([], 'linux', 'x64')
  assert.ok(missing.some((error) => error.includes('@typescript+typescript-linux-x64@')))
  assert.ok(missing.some((error) => error.includes('@esbuild+linux-x64@')))
  assert.ok(missing.some((error) => error.includes('lightningcss-linux-x64-gnu@')))
})

test('flags Linux packages contaminating a Darwin install and vice versa', () => {
  const darwinMarkers = expectedNativeMarkers('darwin', 'arm64').map((marker) => `${marker}1.0.0`)
  const contaminatedDarwin = [
    ...darwinMarkers,
    '@biomejs+cli-linux-arm64@2.5.5',
    '@esbuild+linux-arm64@0.28.1',
  ]
  const darwinErrors = dependencyTreeErrors(contaminatedDarwin, 'darwin', 'arm64')
  assert.ok(darwinErrors.some((error) => error.includes('@biomejs/cli')))
  assert.ok(darwinErrors.some((error) => error.includes('@esbuild')))

  const linuxMarkers = expectedNativeMarkers('linux', 'arm64').map((marker) => `${marker}1.0.0`)
  const contaminatedLinux = [...linuxMarkers, '@rolldown+binding-darwin-arm64@1.1.5']
  const linuxErrors = dependencyTreeErrors(contaminatedLinux, 'linux', 'arm64')
  assert.ok(linuxErrors.some((error) => error.includes('@rolldown/binding')))
})

test('reports unsupported platform/architecture combinations', () => {
  const errors = dependencyTreeErrors([], 'darwin', 'x64')
  assert.ok(errors.some((error) => /unsupported platform\/architecture: darwin\/x64/.test(error)))
  assert.deepEqual(expectedNativeMarkers('darwin', 'x64'), [])
})
