import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { execFile, spawn } from 'node:child_process'
import { mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const HOLDER_SOURCE = `
const token = process.argv[1]
process.stdout.write(token + '\\n')
process.stdin.resume()
process.stdin.on('end', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
`

export type GpuOwner = 'composition' | 'gemma' | 'qwen3-tts'

export interface GpuLease {
  readonly owner: GpuOwner
  readonly lockFilePath: string
  release(): Promise<void>
}

/** One cross-process contract used by every model composition that can own CUDA. */
export interface ExclusiveGpuLeaseCoordinator {
  acquire(owner: GpuOwner, signal?: AbortSignal): Promise<GpuLease>
}

export type GpuLeaseErrorCode = 'busy' | 'cancelled' | 'diagnostic' | 'unavailable'

export class GpuLeaseError extends Error {
  override readonly name = 'GpuLeaseError'
  readonly code: GpuLeaseErrorCode

  constructor(code: GpuLeaseErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
  }
}

export interface FileGpuLeaseCoordinatorConfig {
  /** Required stable file path shared by Gemma, Qwen, and the final composition root. */
  readonly lockFilePath: string
  readonly flockExecutable?: string
  readonly nvidiaSmiExecutable?: string
  /** Diagnostic fail-closed check for uncoordinated pre-existing GPU users; flock is the guarantee. */
  readonly inspectExistingComputeProcesses?: boolean
  readonly releaseGraceMs?: number
}

interface HolderExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly error?: unknown
}

export class FileGpuLeaseCoordinator implements ExclusiveGpuLeaseCoordinator {
  readonly #lockFilePath: string
  readonly #flockExecutable: string
  readonly #nvidiaSmiExecutable: string
  readonly #inspectExistingComputeProcesses: boolean
  readonly #releaseGraceMs: number

  constructor(config: FileGpuLeaseCoordinatorConfig) {
    if (config.lockFilePath.length === 0)
      throw new GpuLeaseError('unavailable', 'GPU lock file path is required')
    this.#lockFilePath = resolve(config.lockFilePath)
    this.#flockExecutable = config.flockExecutable ?? 'flock'
    this.#nvidiaSmiExecutable = config.nvidiaSmiExecutable ?? 'nvidia-smi'
    this.#inspectExistingComputeProcesses = config.inspectExistingComputeProcesses ?? true
    this.#releaseGraceMs = config.releaseGraceMs ?? 5_000
    if (!Number.isSafeInteger(this.#releaseGraceMs) || this.#releaseGraceMs < 100) {
      throw new GpuLeaseError('unavailable', 'GPU lease release grace must be at least 100 ms')
    }
  }

  async acquire(owner: GpuOwner, signal?: AbortSignal): Promise<GpuLease> {
    if (signal?.aborted) throw new GpuLeaseError('cancelled', 'GPU lease acquisition was cancelled')
    await mkdir(dirname(this.#lockFilePath), { recursive: true, mode: 0o700 })
    const file = await open(this.#lockFilePath, 'a', 0o600)
    await file.close()

    const token = `${owner}-${process.pid}-${crypto.randomUUID()}`
    const child = spawn(
      this.#flockExecutable,
      [
        '--exclusive',
        '--nonblock',
        '--conflict-exit-code',
        '75',
        this.#lockFilePath,
        process.execPath,
        '-e',
        HOLDER_SOURCE,
        token,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] as const, windowsHide: true },
    )
    const exit = new Promise<HolderExit>((resolveExit) => {
      let settled = false
      const settle = (result: HolderExit): void => {
        if (settled) return
        settled = true
        resolveExit(result)
      }
      child.once('error', (error) => settle({ code: null, signal: null, error }))
      child.once('close', (code, closeSignal) => settle({ code, signal: closeSignal }))
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4_000)
    })

    let acquired = false
    const cancel = (): void => {
      child.kill('SIGTERM')
    }
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      acquired = await this.#waitForToken(child, exit, token)
      if (!acquired) {
        const result = await exit
        if (signal?.aborted)
          throw new GpuLeaseError('cancelled', 'GPU lease acquisition was cancelled')
        if (result.code === 75) {
          throw new GpuLeaseError('busy', `GPU lease is already held: ${this.#lockFilePath}`)
        }
        throw new GpuLeaseError(
          'unavailable',
          `GPU lease holder failed to start: ${stderr.trim() || result.error || `exit ${result.code}`}`,
        )
      }
      if (signal?.aborted) {
        await this.#stopHolder(child, exit)
        throw new GpuLeaseError('cancelled', 'GPU lease acquisition was cancelled')
      }
      if (this.#inspectExistingComputeProcesses) await this.#diagnoseExistingCompute(signal)

      let released = false
      return {
        owner,
        lockFilePath: this.#lockFilePath,
        release: async () => {
          if (released) return
          released = true
          await this.#stopHolder(child, exit)
        },
      }
    } catch (error) {
      if (acquired) await this.#stopHolder(child, exit)
      if (error instanceof GpuLeaseError) throw error
      if (signal?.aborted)
        throw new GpuLeaseError('cancelled', 'GPU lease acquisition was cancelled', {
          cause: error,
        })
      throw new GpuLeaseError('unavailable', 'Could not acquire the cross-process GPU lease', {
        cause: error,
      })
    } finally {
      signal?.removeEventListener('abort', cancel)
    }
  }

  async #waitForToken(
    child: ChildProcessWithoutNullStreams,
    exit: Promise<HolderExit>,
    token: string,
  ): Promise<boolean> {
    child.stdout.setEncoding('utf8')
    return await new Promise<boolean>((resolveReady) => {
      let settled = false
      let output = ''
      const finish = (value: boolean): void => {
        if (settled) return
        settled = true
        resolveReady(value)
      }
      child.stdout.on('data', (chunk: string) => {
        output += chunk
        if (output.split(/\r?\n/u).includes(token)) finish(true)
        if (output.length > 4_000) finish(false)
      })
      void exit.then(() => finish(false))
    })
  }

  async #diagnoseExistingCompute(signal?: AbortSignal): Promise<void> {
    let stdout: string
    try {
      ;({ stdout } = await execFileAsync(
        this.#nvidiaSmiExecutable,
        ['--query-compute-apps=pid,process_name,used_gpu_memory', '--format=csv,noheader,nounits'],
        { encoding: 'utf8', maxBuffer: 64 * 1024, signal },
      ))
    } catch (error) {
      if (signal?.aborted)
        throw new GpuLeaseError('cancelled', 'GPU diagnostic was cancelled', { cause: error })
      throw new GpuLeaseError('diagnostic', 'Could not inspect existing GPU compute processes', {
        cause: error,
      })
    }
    const active = stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
    if (active.length > 0) {
      throw new GpuLeaseError(
        'diagnostic',
        `Uncoordinated GPU compute process detected after lease acquisition: ${active.join('; ')}`,
      )
    }
  }

  async #stopHolder(
    child: ChildProcessWithoutNullStreams,
    exit: Promise<HolderExit>,
  ): Promise<void> {
    if (child.exitCode === null && child.signalCode === null) child.stdin.end()
    const timeout = setTimeout(() => child.kill('SIGKILL'), this.#releaseGraceMs)
    timeout.unref()
    const result = await exit
    clearTimeout(timeout)
    if (result.error !== undefined)
      throw new GpuLeaseError('unavailable', 'GPU lease holder process failed', {
        cause: result.error,
      })
    if (result.signal === 'SIGKILL')
      throw new GpuLeaseError('unavailable', 'GPU lease holder required SIGKILL during release')
  }
}
