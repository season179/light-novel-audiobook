#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function validateConfigureFlags(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('darwin-arm64 configureFlags must be a nonempty array')
  }

  const seen = new Set()
  for (const flag of value) {
    if (typeof flag !== 'string' || flag.length <= 2 || !flag.startsWith('--')) {
      throw new Error('every darwin-arm64 configure flag must be a nonempty --... string')
    }
    if (/[\0\s]/u.test(flag)) {
      throw new Error(
        `unsafe whitespace or NUL in darwin-arm64 configure flag: ${JSON.stringify(flag)}`,
      )
    }
    if (seen.has(flag)) {
      throw new Error(`duplicate darwin-arm64 configure flag: ${flag}`)
    }
    seen.add(flag)
  }

  return [...value]
}

export function configureFlagsSha256(configureFlags) {
  const flags = validateConfigureFlags(configureFlags)
  return createHash('sha256').update(JSON.stringify(flags), 'utf8').digest('hex')
}

export function readDarwinBuild(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const build = manifest.builds?.['darwin-arm64']
  if (!build) throw new Error('config/ffmpeg-artifacts.json is missing builds.darwin-arm64')
  return {
    version: manifest.version,
    build,
    configureFlags: validateConfigureFlags(build.configureFlags),
  }
}

export function createBuildSidecar({
  manifestPath,
  version,
  platform,
  source,
  toolchain,
  binaries,
}) {
  const configuredBuild = readDarwinBuild(manifestPath)
  if (version !== configuredBuild.version) {
    throw new Error(
      `sidecar version ${version} does not match configured version ${configuredBuild.version}`,
    )
  }
  const configureFlags = configuredBuild.configureFlags

  return {
    schemaVersion: 1,
    version,
    platform,
    source,
    configureFlags,
    configureFlagsSha256: configureFlagsSha256(configureFlags),
    toolchain,
    binaries,
  }
}

export function validateBuildSidecar(sidecar, expectedConfigureFlags) {
  const flags = validateConfigureFlags(sidecar.configureFlags)
  const actualHash = configureFlagsSha256(flags)
  if (sidecar.configureFlagsSha256 !== actualHash) {
    throw new Error(
      `sidecar configureFlagsSha256 drift: expected ${actualHash}, got ${sidecar.configureFlagsSha256}`,
    )
  }
  if (
    expectedConfigureFlags &&
    JSON.stringify(flags) !== JSON.stringify(validateConfigureFlags(expectedConfigureFlags))
  ) {
    throw new Error('sidecar configureFlags drifted from config/ffmpeg-artifacts.json')
  }
  return sidecar
}

export function writeBuildSidecar(outputPath, values) {
  const sidecar = createBuildSidecar(values)
  validateBuildSidecar(sidecar, readDarwinBuild(values.manifestPath).configureFlags)
  writeFileSync(outputPath, `${JSON.stringify(sidecar, null, 2)}\n`)
  return sidecar
}

function requireArguments(command, values, count) {
  if (values.length !== count) {
    throw new Error(`${command} expected ${count} arguments, received ${values.length}`)
  }
}

function main(argv) {
  const [command, ...values] = argv
  if (command === 'flags') {
    requireArguments(command, values, 1)
    const { configureFlags } = readDarwinBuild(values[0])
    process.stdout.write(`${configureFlags.join('\n')}\n`)
    return
  }

  if (command === 'write-sidecar') {
    requireArguments(command, values, 16)
    const [
      manifestPath,
      outputPath,
      version,
      platform,
      sourceUrl,
      sourceSha256,
      macos,
      xcode,
      appleClang,
      sdkPath,
      sdkVersion,
      make,
      ffmpegPath,
      ffmpegSha256,
      ffprobePath,
      ffprobeSha256,
    ] = values
    writeBuildSidecar(outputPath, {
      manifestPath,
      version,
      platform,
      source: { url: sourceUrl, archiveSha256: sourceSha256 },
      toolchain: { platform, macos, xcode, appleClang, sdkPath, sdkVersion, make },
      binaries: {
        ffmpeg: { path: ffmpegPath, sha256: ffmpegSha256 },
        ffprobe: { path: ffprobePath, sha256: ffprobeSha256 },
      },
    })
    return
  }

  if (command === 'verify-sidecar') {
    requireArguments(command, values, 2)
    const expectedFlags = readDarwinBuild(values[0]).configureFlags
    const sidecar = JSON.parse(readFileSync(values[1], 'utf8'))
    validateBuildSidecar(sidecar, expectedFlags)
    return
  }

  throw new Error('usage: ffmpeg-build-manifest.mjs flags|write-sidecar|verify-sidecar ...')
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : error}`)
    process.exitCode = 1
  }
}
