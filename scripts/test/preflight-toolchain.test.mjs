import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { arch, platform, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  dependencyTreeErrors,
  expectedNativeMarkers,
  formatPreflightResult,
  inspectToolchainFacts,
  isMountedWindowsPath,
  parseVersion,
} from '../preflight-toolchain.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const fixture = JSON.parse(
  readFileSync(
    join(repositoryRoot, 'scripts/test/fixtures/preflight-toolchain/linux-x64-gnu.json'),
    'utf8',
  ),
)

function completeFacts(overrides = {}) {
  return {
    detectedPlatform: 'linux',
    detectedArch: 'x64',
    nodeVersion: 'v24.16.0',
    nodeExecutablePath: '/usr/local/bin/node',
    nodeRealPath: '/usr/local/bin/node',
    osRelease: '6.11.0-generic',
    procVersion: 'Linux version 6.11.0-generic',
    wslDistroName: '',
    packageManager: 'pnpm@11.17.0',
    pnpmPath: '/usr/local/bin/pnpm',
    pnpmRealPath: '/usr/local/bin/pnpm',
    pnpmResolutionError: '',
    pnpmVersion: '11.17.0',
    pnpmExecutionError: '',
    virtualStoreExists: true,
    virtualStoreEntries: expectedNativeMarkers('linux', 'x64').map((marker) => `${marker}1.0.0`),
    libc: 'gnu',
    ...overrides,
  }
}

function inspectFacts(overrides = {}, options = { requireDependencies: true }) {
  return inspectToolchainFacts(completeFacts(overrides), options)
}

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

test('pins complete and missing Linux dependency arrays for every architecture/libc pair', () => {
  for (const cpuArchitecture of ['x64', 'arm64']) {
    for (const libc of ['gnu', 'musl']) {
      const markers = expectedNativeMarkers('linux', cpuArchitecture, libc)
      assert.deepEqual(
        dependencyTreeErrors(
          markers.map((marker) => `${marker}1.0.0`),
          'linux',
          cpuArchitecture,
          { libc },
        ),
        [],
      )
      assert.deepEqual(
        dependencyTreeErrors([], 'linux', cpuArchitecture, { libc }),
        markers.map(
          (marker) => `node_modules is missing the native Linux package matching ${marker}*`,
        ),
      )
    }
  }
})

test('pins the complete ordered Linux contamination array', () => {
  const entries = [
    ...expectedNativeMarkers('linux', 'x64').map((marker) => `${marker}1.0.0`),
    '@biomejs+cli-win32-x64@2.5.5',
    '@esbuild+win32-x64@0.27.7',
    'lightningcss-win32-x64-msvc@1.33.0',
  ]
  assert.deepEqual(dependencyTreeErrors(entries, 'linux', 'x64'), [
    '@biomejs/cli contains native packages for another platform: @biomejs+cli-win32-x64@2.5.5',
    '@esbuild contains native packages for another platform: @esbuild+win32-x64@0.27.7',
    'lightningcss contains native packages for another platform: lightningcss-win32-x64-msvc@1.33.0',
  ])
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

test('reports unsupported platform/architecture combinations verbatim', () => {
  assert.deepEqual(dependencyTreeErrors([], 'darwin', 'x64'), [
    'unsupported platform/architecture: darwin/x64',
  ])
  assert.deepEqual(dependencyTreeErrors([], 'linux', 'riscv64'), [
    'unsupported Linux CPU architecture: riscv64',
  ])
  assert.deepEqual(expectedNativeMarkers('darwin', 'x64'), [])
})

test('restores Linux pnpm, mounted-Windows, and WSL1 diagnostics in exact order', () => {
  assert.deepEqual(inspectFacts({ pnpmPath: '', pnpmRealPath: '', pnpmVersion: '' }).errors, [
    'native Linux pnpm is not available on PATH',
  ])
  assert.deepEqual(inspectFacts({ pnpmVersion: '', pnpmExecutionError: 'spawn EACCES' }).errors, [
    'pnpm could not execute as a native Linux tool: spawn EACCES',
  ])
  assert.deepEqual(inspectFacts({ pnpmVersion: '' }).errors, [
    'pnpm 11.17.0 is required; detected an unusable pnpm executable',
  ])
  assert.deepEqual(
    inspectFacts({
      nodeExecutablePath: '/mnt/c/Program Files/nodejs/node.exe',
      nodeRealPath: '/mnt/c/Program Files/nodejs/node.exe',
      pnpmPath: '/mnt/c/Users/season/pnpm.cmd',
      pnpmRealPath: '/mnt/c/Users/season/pnpm.cmd',
      pnpmVersion: '',
    }).errors,
    [
      'Node resolves through a mounted Windows path: /mnt/c/Program Files/nodejs/node.exe',
      'pnpm resolves to a Windows tool instead of native WSL2 pnpm: /mnt/c/Users/season/pnpm.cmd',
    ],
  )
  assert.deepEqual(
    inspectFacts({
      osRelease: '4.4.0-microsoft',
      procVersion: 'Linux version 4.4.0-Microsoft',
      wslDistroName: 'Ubuntu',
    }).errors,
    ['WSL was detected, but the kernel does not identify itself as WSL2'],
  )
})

test('restores Linux missing-node_modules and lazy unsupported-architecture control flow', () => {
  assert.deepEqual(inspectFacts({ virtualStoreExists: false, virtualStoreEntries: [] }).errors, [
    'node_modules is missing; run pnpm install --frozen-lockfile from WSL2',
  ])
  assert.deepEqual(
    inspectFacts(
      { virtualStoreExists: false, virtualStoreEntries: [] },
      { requireDependencies: false },
    ).errors,
    [],
  )

  const unsupported = { detectedArch: 'riscv64', virtualStoreEntries: [] }
  assert.deepEqual(inspectFacts(unsupported).errors, [
    'unsupported Linux CPU architecture: riscv64',
  ])
  assert.deepEqual(inspectFacts(unsupported, { requireDependencies: false }).errors, [
    'unsupported Linux CPU architecture: riscv64',
  ])
  assert.deepEqual(
    inspectFacts({ ...unsupported, virtualStoreExists: false }, { requireDependencies: false })
      .errors,
    [],
  )
  assert.deepEqual(inspectFacts({ ...unsupported, virtualStoreExists: false }).errors, [
    'node_modules is missing; run pnpm install --frozen-lockfile from WSL2',
  ])
})

test('pins Darwin arm64 markers/contamination and eager Darwin x64 rejection', () => {
  const markers = expectedNativeMarkers('darwin', 'arm64')
  assert.deepEqual(
    inspectFacts({
      detectedPlatform: 'darwin',
      detectedArch: 'arm64',
      virtualStoreEntries: [
        ...markers.map((marker) => `${marker}1.0.0`),
        '@rolldown+binding-linux-arm64-gnu@1.1.5',
      ],
    }).errors,
    [
      '@rolldown/binding contains native packages for another platform: @rolldown+binding-linux-arm64-gnu@1.1.5',
    ],
  )
  assert.deepEqual(
    inspectFacts({
      detectedPlatform: 'darwin',
      detectedArch: 'x64',
      virtualStoreEntries: [],
    }).errors,
    [
      'Node must run on a supported native platform/architecture (linux x64/arm64 or darwin arm64); detected darwin/x64',
    ],
  )
})

test('pins complete CLI formatting, footer, and WSL2/native Linux success labels', () => {
  assert.deepEqual(
    formatPreflightResult({
      ...inspectFacts(),
      errors: ['first failure', 'second failure'],
    }),
    {
      exitCode: 1,
      stdout: '',
      stderr:
        'Toolchain preflight failed:\n- first failure\n- second failure\n\nSee docs/DEVELOPMENT.md for the native WSL2 setup and cleanup steps.\n',
    },
  )
  assert.deepEqual(formatPreflightResult(inspectFacts()), {
    exitCode: 0,
    stdout:
      'Toolchain preflight passed (native Linux, Node v24.16.0, pnpm at /usr/local/bin/pnpm).\n',
    stderr: '',
  })
  assert.deepEqual(
    formatPreflightResult(
      inspectFacts({
        osRelease: '6.6.87.2-microsoft-standard-WSL2',
        procVersion: 'Linux version 6.6.87.2-microsoft-standard-WSL2',
        wslDistroName: 'Ubuntu',
      }),
    ),
    {
      exitCode: 0,
      stdout: 'Toolchain preflight passed (WSL2, Node v24.16.0, pnpm at /usr/local/bin/pnpm).\n',
      stderr: '',
    },
  )
})

const isNativeUbuntuShape =
  platform() === 'linux' &&
  arch() === 'x64' &&
  Boolean(process.report?.getReport().header?.glibcVersionRuntime) &&
  !process.env.WSL_DISTRO_NAME

function populateVirtualStore(root, entries) {
  const virtualStore = join(root, 'node_modules', '.pnpm')
  rmSync(virtualStore, { force: true, recursive: true })
  for (const entry of entries) mkdirSync(join(virtualStore, entry), { recursive: true })
}

test('real inspectToolchain and CLI preserve the committed Ubuntu characterization fixture', {
  skip: !isNativeUbuntuShape,
}, async (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'lna-preflight-ubuntu-'))
  t.after(() => rmSync(fixtureRoot, { force: true, recursive: true }))
  mkdirSync(join(fixtureRoot, 'scripts'), { recursive: true })
  cpSync(
    join(repositoryRoot, 'scripts', 'preflight-toolchain.mjs'),
    join(fixtureRoot, 'scripts', 'preflight-toolchain.mjs'),
  )
  writeFileSync(
    join(fixtureRoot, 'package.json'),
    `${JSON.stringify({ packageManager: fixture.packageManager }, null, 2)}\n`,
  )

  populateVirtualStore(fixtureRoot, fixture.completeEntries)
  const fixtureModule = await import(
    `${pathToFileURL(join(fixtureRoot, 'scripts', 'preflight-toolchain.mjs')).href}?fixture=${Date.now()}`
  )
  const inspected = fixtureModule.inspectToolchain({ requireDependencies: true })
  assert.deepEqual(inspected.errors, [])

  const success = spawnSync(
    process.execPath,
    [join(fixtureRoot, 'scripts', 'preflight-toolchain.mjs'), '--dependencies'],
    { cwd: fixtureRoot, encoding: 'utf8' },
  )
  assert.equal(success.status, 0)
  assert.equal(success.stderr, '')
  assert.equal(
    success.stdout,
    `Toolchain preflight passed (native Linux, Node ${process.version}, pnpm at ${inspected.pnpmPath}).\n`,
  )

  populateVirtualStore(fixtureRoot, fixture.failingEntries)
  const failure = spawnSync(
    process.execPath,
    [join(fixtureRoot, 'scripts', 'preflight-toolchain.mjs'), '--dependencies'],
    { cwd: fixtureRoot, encoding: 'utf8' },
  )
  assert.equal(failure.status, 1)
  assert.equal(failure.stdout, '')
  assert.equal(
    failure.stderr,
    `Toolchain preflight failed:\n${fixture.failingErrors.map((error) => `- ${error}`).join('\n')}\n\nSee docs/DEVELOPMENT.md for the native WSL2 setup and cleanup steps.\n`,
  )
})
