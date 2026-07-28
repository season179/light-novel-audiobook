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
    errors.push(
      targetPlatform === 'linux'
        ? `unsupported Linux CPU architecture: ${cpuArchitecture}`
        : `unsupported platform/architecture: ${targetPlatform}/${cpuArchitecture}`,
    )
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
      const platformLabel = targetPlatform === 'linux' ? 'Linux' : targetPlatform
      errors.push(`node_modules is missing the native ${platformLabel} package matching ${marker}*`)
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

export function collectHostFacts() {
  const detectedPlatform = platform()
  const detectedArch = arch()
  const packageJson = readJson(join(repositoryRoot, 'package.json'))
  const nodeRealPath = realpathSync(process.execPath)
  const osRelease = release()
  const procVersion = existsSync('/proc/version') ? readFileSync('/proc/version', 'utf8') : ''
  const pnpmPath = findPnpm()
  let pnpmRealPath = ''
  let pnpmResolutionError = ''

  if (pnpmPath) {
    try {
      pnpmRealPath = realpathSync(pnpmPath)
    } catch (error) {
      pnpmResolutionError = error instanceof Error ? error.message : String(error)
    }
  }

  const packageManager = packageJson.packageManager ?? ''
  const packageManagerMatch = /^pnpm@(\d+\.\d+\.\d+)$/.exec(packageManager)
  let pnpmVersion = ''
  let pnpmExecutionError = ''
  if (
    pnpmRealPath &&
    packageManagerMatch &&
    !isMountedWindowsPath(pnpmRealPath) &&
    !/\.(?:cmd|exe)$/i.test(pnpmRealPath)
  ) {
    const result = spawnSync(pnpmRealPath, ['--version'], { encoding: 'utf8', env: process.env })
    pnpmVersion = result.status === 0 ? result.stdout.trim() : ''
    pnpmExecutionError = result.error?.message ?? ''
  }

  const virtualStore = join(repositoryRoot, 'node_modules', '.pnpm')
  const virtualStoreExists = existsSync(virtualStore)
  return {
    detectedPlatform,
    detectedArch,
    nodeVersion: process.version,
    nodeExecutablePath: process.execPath,
    nodeRealPath,
    osRelease,
    procVersion,
    wslDistroName: process.env.WSL_DISTRO_NAME ?? '',
    packageManager,
    pnpmPath,
    pnpmRealPath,
    pnpmResolutionError,
    pnpmVersion,
    pnpmExecutionError,
    virtualStoreExists,
    virtualStoreEntries: virtualStoreExists ? readdirSync(virtualStore) : [],
    libc: virtualStoreExists ? detectLibc() : 'gnu',
  }
}

// Pure policy seam: production always calls collectHostFacts(); tests inject facts here rather
// than introducing environment-variable overrides into the preinstall/postinstall path.
export function inspectToolchainFacts(facts, { requireDependencies = false } = {}) {
  const errors = []
  const nodeVersion = parseVersion(facts.nodeVersion)
  const packageManagerMatch = /^pnpm@(\d+\.\d+\.\d+)$/.exec(facts.packageManager)
  const supportedDarwinHost = facts.detectedPlatform === 'darwin' && facts.detectedArch === 'arm64'

  // Linux intentionally retains main's lazy unsupported-architecture path: architecture is only
  // diagnosed when a virtual store exists. Darwin rejects unsupported hosts eagerly.
  if (facts.detectedPlatform !== 'linux' && !supportedDarwinHost) {
    errors.push(
      `Node must run on a supported native platform/architecture (linux x64/arm64 or darwin arm64); detected ${facts.detectedPlatform}/${facts.detectedArch}`,
    )
  }
  if (!nodeVersion || nodeVersion.major < 24) {
    errors.push(`Node.js 24 or newer is required; detected ${facts.nodeVersion}`)
  }
  if (isMountedWindowsPath(facts.nodeRealPath)) {
    errors.push(`Node resolves through a mounted Windows path: ${facts.nodeExecutablePath}`)
  }

  const isWsl =
    facts.detectedPlatform === 'linux' &&
    (Boolean(facts.wslDistroName) ||
      /microsoft/i.test(facts.osRelease) ||
      /microsoft/i.test(facts.procVersion))
  if (isWsl && !/wsl2|microsoft-standard-wsl2/i.test(`${facts.osRelease} ${facts.procVersion}`)) {
    errors.push('WSL was detected, but the kernel does not identify itself as WSL2')
  }

  if (!packageManagerMatch) {
    errors.push('package.json must pin packageManager to an exact pnpm version')
  }

  const platformLabel = facts.detectedPlatform === 'linux' ? 'Linux ' : ''
  if (!facts.pnpmPath) {
    errors.push(`native ${platformLabel}pnpm is not available on PATH`)
  } else if (facts.pnpmResolutionError) {
    errors.push(`pnpm path cannot be resolved: ${facts.pnpmResolutionError}`)
  }

  if (
    facts.pnpmRealPath &&
    (isMountedWindowsPath(facts.pnpmRealPath) || /\.(?:cmd|exe)$/i.test(facts.pnpmRealPath))
  ) {
    errors.push(
      `pnpm resolves to a Windows tool instead of native WSL2 pnpm: ${facts.pnpmRealPath}`,
    )
  } else if (facts.pnpmRealPath && packageManagerMatch) {
    const expectedVersion = packageManagerMatch[1]
    if (facts.pnpmVersion !== expectedVersion) {
      errors.push(
        facts.pnpmExecutionError
          ? `pnpm could not execute as a native ${platformLabel}tool: ${facts.pnpmExecutionError}`
          : `pnpm ${expectedVersion} is required; detected ${facts.pnpmVersion || 'an unusable pnpm executable'}`,
      )
    }
  }

  if (facts.virtualStoreExists) {
    if (facts.detectedPlatform === 'linux' || supportedDarwinHost) {
      errors.push(
        ...dependencyTreeErrors(
          facts.virtualStoreEntries,
          facts.detectedPlatform,
          facts.detectedArch,
          { libc: facts.libc, required: requireDependencies },
        ),
      )
    }
  } else if (requireDependencies) {
    errors.push(
      facts.detectedPlatform === 'linux'
        ? 'node_modules is missing; run pnpm install --frozen-lockfile from WSL2'
        : 'node_modules is missing; run pnpm install --frozen-lockfile',
    )
  }

  return {
    errors,
    isWsl,
    pnpmPath: facts.pnpmRealPath || facts.pnpmPath,
    detectedPlatform: facts.detectedPlatform,
    nodeVersion: facts.nodeVersion,
  }
}

export function inspectToolchain(options = {}) {
  return inspectToolchainFacts(collectHostFacts(), options)
}

export function formatPreflightResult(result) {
  if (result.errors.length > 0) {
    const docsLabel = result.detectedPlatform === 'darwin' ? 'macOS' : 'WSL2'
    return {
      exitCode: 1,
      stdout: '',
      stderr: `Toolchain preflight failed:\n${result.errors.map((error) => `- ${error}`).join('\n')}\n\nSee docs/DEVELOPMENT.md for the native ${docsLabel} setup and cleanup steps.\n`,
    }
  }

  const environment = result.isWsl
    ? 'WSL2'
    : result.detectedPlatform === 'darwin'
      ? 'macOS arm64'
      : 'native Linux'
  return {
    exitCode: 0,
    stdout: `Toolchain preflight passed (${environment}, Node ${result.nodeVersion}, pnpm at ${result.pnpmPath}).\n`,
    stderr: '',
  }
}

function main() {
  const requireDependencies = process.argv.includes('--dependencies')
  const output = formatPreflightResult(inspectToolchain({ requireDependencies }))
  if (output.stdout) process.stdout.write(output.stdout)
  if (output.stderr) process.stderr.write(output.stderr)
  process.exitCode = output.exitCode
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main()
