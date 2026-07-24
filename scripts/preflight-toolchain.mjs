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

export function expectedNativeMarkers(cpuArchitecture, libc = 'gnu') {
  const architectureNames = { arm64: 'arm64', x64: 'x64' }
  const packageArchitecture = architectureNames[cpuArchitecture]
  if (!packageArchitecture) return []

  return [
    `@biomejs+cli-linux-${packageArchitecture}@`,
    `@typescript+typescript-linux-${packageArchitecture}@`,
    `@rolldown+binding-linux-${packageArchitecture}-${libc}@`,
  ]
}

export function dependencyTreeErrors(entries, cpuArchitecture, libc = 'gnu', required = true) {
  const errors = []
  const expectedMarkers = expectedNativeMarkers(cpuArchitecture, libc)

  if (expectedMarkers.length === 0) {
    errors.push(`unsupported Linux CPU architecture: ${cpuArchitecture}`)
    return errors
  }

  const windowsEntries = entries.filter((entry) =>
    /(?:cli|typescript|binding)-win32-(?:arm64|x64)/.test(entry),
  )
  if (windowsEntries.length > 0) {
    errors.push(
      'node_modules contains Windows native packages; remove all workspace node_modules directories and reinstall from WSL2',
    )
  }

  if (required) {
    for (const marker of expectedMarkers) {
      if (!entries.some((entry) => entry.startsWith(marker))) {
        errors.push(`node_modules is missing the native Linux package matching ${marker}*`)
      }
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

export function inspectToolchain({ requireDependencies = false } = {}) {
  const errors = []
  const packageJson = readJson(join(repositoryRoot, 'package.json'))
  const nodeVersion = parseVersion(process.version)
  const packageManagerMatch = /^pnpm@(\d+\.\d+\.\d+)$/.exec(packageJson.packageManager ?? '')

  if (platform() !== 'linux') {
    errors.push(`Node must be a native Linux executable; detected platform ${platform()}`)
  }
  if (!nodeVersion || nodeVersion.major < 24) {
    errors.push(`Node.js 24 or newer is required; detected ${process.version}`)
  }
  if (isMountedWindowsPath(realpathSync(process.execPath))) {
    errors.push(`Node resolves through a mounted Windows path: ${process.execPath}`)
  }

  const procVersion = existsSync('/proc/version') ? readFileSync('/proc/version', 'utf8') : ''
  const isWsl =
    Boolean(process.env.WSL_DISTRO_NAME) ||
    /microsoft/i.test(release()) ||
    /microsoft/i.test(procVersion)
  if (isWsl && !/wsl2|microsoft-standard-wsl2/i.test(`${release()} ${procVersion}`)) {
    errors.push('WSL was detected, but the kernel does not identify itself as WSL2')
  }

  if (!packageManagerMatch) {
    errors.push('package.json must pin packageManager to an exact pnpm version')
  }

  const pnpmPath = findPnpm()
  if (!pnpmPath) {
    errors.push('native Linux pnpm is not available on PATH')
  } else if (isMountedWindowsPath(pnpmPath) || /\.(?:cmd|exe)$/i.test(pnpmPath)) {
    errors.push(`pnpm resolves to a Windows tool instead of native WSL2 pnpm: ${pnpmPath}`)
  } else if (packageManagerMatch) {
    const result = spawnSync(pnpmPath, ['--version'], { encoding: 'utf8', env: process.env })
    const actualVersion = result.status === 0 ? result.stdout.trim() : ''
    const expectedVersion = packageManagerMatch[1]
    if (actualVersion !== expectedVersion) {
      errors.push(
        result.error
          ? `pnpm could not execute as a native Linux tool: ${result.error.message}`
          : `pnpm ${expectedVersion} is required; detected ${actualVersion || 'an unusable pnpm executable'}`,
      )
    }
  }

  const virtualStore = join(repositoryRoot, 'node_modules', '.pnpm')
  if (existsSync(virtualStore)) {
    errors.push(
      ...dependencyTreeErrors(readdirSync(virtualStore), arch(), detectLibc(), requireDependencies),
    )
  } else if (requireDependencies) {
    errors.push('node_modules is missing; run pnpm install --frozen-lockfile from WSL2')
  }

  return { errors, isWsl, pnpmPath }
}

function main() {
  const requireDependencies = process.argv.includes('--dependencies')
  const result = inspectToolchain({ requireDependencies })

  if (result.errors.length > 0) {
    console.error('Toolchain preflight failed:')
    for (const error of result.errors) console.error(`- ${error}`)
    console.error('\nSee docs/DEVELOPMENT.md for the native WSL2 setup and cleanup steps.')
    process.exitCode = 1
    return
  }

  const environment = result.isWsl ? 'WSL2' : 'native Linux'
  console.log(
    `Toolchain preflight passed (${environment}, Node ${process.version}, pnpm at ${result.pnpmPath}).`,
  )
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main()
