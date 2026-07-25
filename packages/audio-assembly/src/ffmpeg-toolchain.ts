import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { type CommandRunner, runChecked, SpawnCommandRunner } from './command-runner.js'
import { FfmpegToolchainError } from './errors.js'

/** The pinned static build installed by the project toolchain, never a system-wide FFmpeg. */
export const defaultFfmpegDirectory = (): string =>
  join(homedir(), '.local', 'share', 'light-novel-audiobook', 'tools', 'ffmpeg', 'current')

export const FFMPEG_DIRECTORY_ENV = 'LIGHT_NOVEL_AUDIOBOOK_FFMPEG_DIR'

/** FFmpeg 7.0.2 is the version this adapter's parameters and probe expectations were verified on. */
export const EXPECTED_FFMPEG_VERSION = '7.0.2'

export interface FfmpegToolchain {
  readonly ffmpegPath: string
  readonly ffprobePath: string
  readonly ffmpegVersion: string
  readonly ffprobeVersion: string
}

export interface ResolveToolchainOptions {
  /** Directory holding `ffmpeg` and `ffprobe`. Defaults to the env override, then the pinned path. */
  readonly directory?: string
  readonly runner?: CommandRunner
  readonly expectedVersion?: string
  /** When true (the default) a version other than the pin is an error, not a warning. */
  readonly requireExpectedVersion?: boolean
  readonly env?: Readonly<Record<string, string | undefined>>
}

/** Reads the version token out of `ffmpeg version 7.0.2-static https://...`. */
export const parseToolVersion = (tool: string, output: string): string => {
  const match = /^(?:ffmpeg|ffprobe) version (\S+)/mu.exec(output)
  if (match?.[1] === undefined) {
    throw new FfmpegToolchainError(`Could not read a version from ${tool}`)
  }
  return match[1]
}

const assertExecutable = async (path: string, tool: string): Promise<void> => {
  try {
    await access(path, constants.X_OK)
  } catch (error) {
    throw new FfmpegToolchainError(
      `Pinned ${tool} is missing or not executable at ${path}. Install the project FFmpeg toolchain or set ${FFMPEG_DIRECTORY_ENV}.`,
      { cause: error },
    )
  }
}

/**
 * Resolves and verifies both binaries up front. Failing here — before any encoding — is what keeps a
 * missing toolchain from surfacing halfway through a long assembly run.
 */
export const resolveFfmpegToolchain = async (
  options: ResolveToolchainOptions = {},
): Promise<FfmpegToolchain> => {
  const env = options.env ?? process.env
  const directory = resolve(
    options.directory ?? env[FFMPEG_DIRECTORY_ENV] ?? defaultFfmpegDirectory(),
  )
  const ffmpegPath = join(directory, 'ffmpeg')
  const ffprobePath = join(directory, 'ffprobe')
  await assertExecutable(ffmpegPath, 'ffmpeg')
  await assertExecutable(ffprobePath, 'ffprobe')

  const runner = options.runner ?? new SpawnCommandRunner()
  const ffmpegVersion = parseToolVersion(
    'ffmpeg',
    (await runChecked(runner, ffmpegPath, ['-hide_banner', '-version'], 'ffmpeg -version')).stdout,
  )
  const ffprobeVersion = parseToolVersion(
    'ffprobe',
    (await runChecked(runner, ffprobePath, ['-hide_banner', '-version'], 'ffprobe -version'))
      .stdout,
  )

  const expected = options.expectedVersion ?? EXPECTED_FFMPEG_VERSION
  if (options.requireExpectedVersion !== false) {
    for (const [tool, version] of [
      ['ffmpeg', ffmpegVersion],
      ['ffprobe', ffprobeVersion],
    ] as const) {
      if (!version.startsWith(expected)) {
        throw new FfmpegToolchainError(
          `Expected ${tool} ${expected} at ${directory} but found ${version}. Assembled audio is only reproducible against the pinned build.`,
        )
      }
    }
  }

  return Object.freeze({ ffmpegPath, ffprobePath, ffmpegVersion, ffprobeVersion })
}
