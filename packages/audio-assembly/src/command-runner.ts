import { spawn } from 'node:child_process'
import { AudioAssemblyError, FfmpegProcessError } from './errors.js'

const NUL_BYTE = String.fromCharCode(0)
const MAX_CAPTURED_STDERR = 64 * 1024

export interface CommandResult {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}

export interface CommandRunner {
  run(executable: string, args: readonly string[], signal?: AbortSignal): Promise<CommandResult>
}

const keepTail = (chunks: readonly string[], limit: number): string => {
  const joined = chunks.join('')
  return joined.length <= limit ? joined : joined.slice(joined.length - limit)
}

/**
 * Spawns FFmpeg directly with an argument array. No shell is involved anywhere in this adapter, so
 * quoting, `$`, backticks, and newlines in book metadata have no interpreter that could act on them.
 */
export class SpawnCommandRunner implements CommandRunner {
  async run(
    executable: string,
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    for (const [index, arg] of args.entries()) {
      if (typeof arg !== 'string' || arg.includes(NUL_BYTE)) {
        throw new AudioAssemblyError(`Command argument ${index} is not a NUL-free string`)
      }
    }

    if (signal?.aborted === true) throw new AudioAssemblyError('Audio assembly was stopped')

    return await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(executable, [...args], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const stdout: string[] = []
      const stderr: string[] = []
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => stdout.push(chunk))
      child.stderr.on('data', (chunk: string) => stderr.push(chunk))
      const stop = () => child.kill('SIGTERM')
      signal?.addEventListener('abort', stop, { once: true })
      if (signal?.aborted === true) stop()
      child.once('error', (error) => {
        signal?.removeEventListener('abort', stop)
        reject(
          new AudioAssemblyError(`Failed to run ${executable}: ${error.message}`, { cause: error }),
        )
      })
      child.once('close', (exitCode, exitSignal) => {
        signal?.removeEventListener('abort', stop)
        if (signal?.aborted === true) {
          reject(new AudioAssemblyError('Audio assembly was stopped'))
          return
        }
        resolve({
          exitCode,
          signal: exitSignal,
          stdout: keepTail(stdout, MAX_CAPTURED_STDERR),
          stderr: keepTail(stderr, MAX_CAPTURED_STDERR),
        })
      })
    })
  }
}

/** Runs a command and turns any non-zero exit into an error carrying the exact argv and stderr. */
export const runChecked = async (
  runner: CommandRunner,
  executable: string,
  args: readonly string[],
  description: string,
  signal?: AbortSignal,
): Promise<CommandResult> => {
  const result = await runner.run(executable, args, signal)
  if (result.exitCode !== 0 || result.signal !== null) {
    throw new FfmpegProcessError({
      message: `${description} failed (exit ${String(result.exitCode)}${
        result.signal === null ? '' : `, signal ${result.signal}`
      })`,
      executable,
      args,
      exitCode: result.exitCode,
      signal: result.signal,
      stderr: result.stderr,
    })
  }
  return result
}
