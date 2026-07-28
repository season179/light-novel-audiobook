#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { arch, platform, release } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, '..')

export function parseVersion(value) {
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim())
  return match
    ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
    : undefined
}

export function isMountedWindowsPath(value) {
  return /^\/mnt\/[a-z](?:\/|$)/i.test(value) || /^[a-z]:[\\/]/i.test(value)
}

// Native optional-dependency families. Each `matches` predicate recognizes every platform variant
// of its family so a foreign-platform package left in node_modules is flagged as contamination,
// while `marker` is the exact entry the current host must have present.
function nativePackageFamilies(targetPlatform, cpuArchitecture, libc = 'gnu') {
  if (targetPlatform === 'linux') {
    const archName = { arm64: 'arm64', x64: 'x64' }[cpuArchitecture]
    if (!archName) return []
    const libcSuffix = libc === 'musl' ? '-musl' : ''
    return [
      {
        family: '@biomejs/cli',
        marker: `@biomejs+cli-linux-${archName}${libcSuffix}@`,
        matches: (entry) => entry.startsWith('@biomejs+cli-'),
      },
      {
        family: '@typescript/typescript',
        marker: `@typescript+typescript-linux-${archName}@`,
        matches: (entry) => entry.startsWith('@typescript+typescript-'),
      },
      {
        family: '@rolldown/binding',
        marker: `@rolldown+binding-linux-${archName}-${libc}@`,
        matches: (entry) => entry.startsWith('@rolldown+binding-'),
      },
      {
        family: '@esbuild',
        marker: `@esbuild+linux-${archName}@`,
        matches: (entry) => entry.startsWith('@esbuild+'),
      },
      {
        family: 'lightningcss',
        marker: `lightningcss-linux-${archName}-${libc}@`,
        matches: (entry) => entry.startsWith('lightningcss-'),
      },
    ]
  }

  if (targetPlatform === 'darwin') {
    const archName = { arm64: 'arm64' }[cpuArchitecture]
    if (!archName) return []
    return [
      {
        family: '@biomejs/cli',
        marker: `@biomejs+cli-darwin-${archName}@`,
        matches: (entry) => entry.startsWith('@biomejs+cli-'),
      },
      {
        family: '@typescript/typescript',
        marker: `@typescript+typescript-darwin-${archName}@`,
        matches: (entry) => entry.startsWith('@typescript+typescript-'),
      },
      {
        family: '@rolldown/binding',
        marker: `@rolldown+binding-darwin-${archName}@`,
        matches: (entry) => entry.startsWith('@rolldown+binding-'),
      },
      {
        family: '@esbuild',
        marker: `@esbuild+darwin-${archName}@`,
        matches: (entry) => entry.startsWith('@esbuild+'),
      },
      {
        family: 'lightningcss',
        marker: `lightningcss-darwin-${archName}@`,
        matches: (entry) => entry.startsWith('lightningcss-'),
      },
    ]
  }

  return []
}

export function expectedNativeMarkers(targetPlatform, cpuArchitecture, libc = 'gnu') {
  return nativePackageFamilies(targetPlatform, cpuArchitecture, libc).map(({ marker }) => marker)
}

export function dependencyTreeErrors(
  entries,
  targetPlatform,
  cpuArchitecture,
  { libc = 'gnu', required = true } = {},
) {
  const errors = []
  const families = nativePackageFamilies(targetPlatform, cpuArchitecture, libc)

  if (families.length === 0) {
    errors.push(`unsupported platform/architecture: ${targetPlatform}/${cpuArchitecture}`)
    return errors
  }

  for (const { family, marker, matches } of families) {
    const mismatches = entries.filter((entry) => matches(entry) && !entry.startsWith(marker))
    if (mismatches.length > 0) {
      errors.push(
        `${family} contains native packages for another platform: ${mismatches.join(', ')}`,
      )
    }
    if (required && !entries.some((entry) => entry.startsWith(marker))) {
      errors.push(
        `node_modules is missing the native ${targetPlatform} package matching ${marker}*`,
      )
    }
  }

  return errors
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function findPnpm() {
  const result = spawnSync('/bin/sh', ['-c', 'command -v pnpm'], {
    encoding: 'utf8',
    env: process.env,
  })
  return result.status === 0 ? result.stdout.trim() : ''
}

function detectLibc() {
  const report = process.report?.getReport()
  return report?.header?.glibcVersionRuntime ? 'gnu' : 'musl'
}

const SUPPORTED_PLATFORMS = new Map([
  ['linux', new Set(['x64', 'arm64'])],
  ['darwin', new Set(['arm64'])],
])

export function inspectToolchain({ requireDependencies = false } = {}) {
  const errors = []
  const detectedPlatform = platform()
  const detectedArch = arch()
  const packageJson = readJson(join(repositoryRoot, 'package.json'))
  const nodeVersion = parseVersion(process.version)
  const packageManagerMatch = /^pnpm@(\d+\.\d+\.\d+)$/.exec(packageJson.packageManager ?? '')
  const supportedArches = SUPPORTED_PLATFORMS.get(detectedPlatform)

  if (!supportedArches?.has(detectedArch)) {
    errors.push(
      `Node must run on a supported native platform/architecture (linux x64/arm64 or darwin arm64); detected ${detectedPlatform}/${detectedArch}`,
    )
  }
  if (!nodeVersion || nodeVersion.major < 24) {
    errors.push(`Node.js 24 or newer is required; detected ${process.version}`)
  }
  if (isMountedWindowsPath(realpathSync(process.execPath))) {
    errors.push(`Node resolves through a mounted Windows path: ${process.execPath}`)
  }

  // WSL2 detection is Linux-only. On Darwin every signal below is absent, so this block is a
  // no-op there; the Windows-path rejection above still guards against mounted-Windows Node.
  const procVersion = existsSync('/proc/version') ? readFileSync('/proc/version', 'utf8') : ''
  const isWsl =
    detectedPlatform === 'linux' &&
    (Boolean(process.env.WSL_DISTRO_NAME) ||
      /microsoft/i.test(release()) ||
      /microsoft/i.test(procVersion))
  if (isWsl && !/wsl2|microsoft-standard-wsl2/i.test(`${release()} ${procVersion}`)) {
    errors.push('WSL was detected, but the kernel does not identify itself as WSL2')
  }

  if (!packageManagerMatch) {
    errors.push('package.json must pin packageManager to an exact pnpm version')
  }

  const pnpmPath = findPnpm()
  let pnpmRealPath = ''
  if (!pnpmPath) {
    errors.push('native pnpm is not available on PATH')
  } else {
    try {
      pnpmRealPath = realpathSync(pnpmPath)
    } catch (error) {
      errors.push(`pnpm path cannot be resolved: ${error instanceof Error ? error.message : error}`)
    }
  }

  if (
    pnpmRealPath &&
    (isMountedWindowsPath(pnpmRealPath) || /\.(?:cmd|exe)$/i.test(pnpmRealPath))
  ) {
    errors.push(`pnpm resolves to a Windows tool instead of native WSL2 pnpm: ${pnpmRealPath}`)
  } else if (pnpmRealPath && packageManagerMatch) {
    const result = spawnSync(pnpmRealPath, ['--version'], { encoding: 'utf8', env: process.env })
    const actualVersion = result.status === 0 ? result.stdout.trim() : ''
    const expectedVersion = packageManagerMatch[1]
    if (actualVersion !== expectedVersion) {
      errors.push(
        result.error
          ? `pnpm could not execute as a native tool: ${result.error.message}`
          : `pnpm ${expectedVersion} is required; detected ${actualVersion || 'an unusable pnpm executable'}`,
      )
    }
  }

  const virtualStore = join(repositoryRoot, 'node_modules', '.pnpm')
  if (existsSync(virtualStore)) {
    if (supportedArches?.has(detectedArch)) {
      errors.push(
        ...dependencyTreeErrors(readdirSync(virtualStore), detectedPlatform, detectedArch, {
          libc: detectLibc(),
          required: requireDependencies,
        }),
      )
    }
  } else if (requireDependencies) {
    errors.push('node_modules is missing; run pnpm install --frozen-lockfile')
  }

  return { errors, isWsl, pnpmPath: pnpmRealPath || pnpmPath }
}

function main() {
  const requireDependencies = process.argv.includes('--dependencies')
  const result = inspectToolchain({ requireDependencies })

  if (result.errors.length > 0) {
    const docsLabel = platform() === 'darwin' ? 'macOS' : 'WSL2'
    console.error('Toolchain preflight failed:')
    for (const error of result.errors) console.error(`- ${error}`)
    console.error(`\nSee docs/DEVELOPMENT.md for the native ${docsLabel} setup and cleanup steps.`)
    process.exitCode = 1
    return
  }

  const environment = result.isWsl
    ? 'WSL2'
    : platform() === 'darwin'
      ? 'macOS arm64'
      : 'native Linux'
  console.log(
    `Toolchain preflight passed (${environment}, Node ${process.version}, pnpm at ${result.pnpmPath}).`,
  )
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main()
