import { execFile } from 'node:child_process'
import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { ExclusiveGpuGate, GpuLease, GpuOwner } from './types.js'
import { SpeechEngineError } from './types.js'

const execFileAsync = promisify(execFile)

export interface FileGpuGateConfig {
  /** Shared lock directory. Gemma must acquire this same path before loading its model. */
  readonly lockDirectory: string
  readonly nvidiaSmiExecutable?: string
}

export class FileGpuGate implements ExclusiveGpuGate {
  readonly #lockDirectory: string
  readonly #nvidiaSmiExecutable: string

  constructor(config: FileGpuGateConfig) {
    this.#lockDirectory = resolve(config.lockDirectory)
    this.#nvidiaSmiExecutable = config.nvidiaSmiExecutable ?? 'nvidia-smi'
  }

  async acquire(owner: GpuOwner, signal?: AbortSignal): Promise<GpuLease> {
    if (signal?.aborted)
      throw new SpeechEngineError('cancelled', 'GPU lease acquisition was cancelled')
    await mkdir(dirname(this.#lockDirectory), { recursive: true, mode: 0o700 })
    try {
      await mkdir(this.#lockDirectory, { mode: 0o700 })
    } catch (error) {
      if (!(await this.#removeStaleLease())) {
        throw new SpeechEngineError(
          'gpu-busy',
          `GPU lease is already held; Gemma and Qwen cannot be resident together (${this.#lockDirectory})`,
          { cause: error },
        )
      }
      try {
        await mkdir(this.#lockDirectory, { mode: 0o700 })
      } catch (retryError) {
        throw new SpeechEngineError('gpu-busy', 'GPU lease was acquired by another process', {
          cause: retryError,
        })
      }
    }

    let released = false
    const release = async (): Promise<void> => {
      if (released) return
      released = true
      await rm(this.#lockDirectory, { recursive: true, force: true })
    }

    try {
      const ownerFile = await open(`${this.#lockDirectory}/owner.json`, 'wx', 0o600)
      try {
        await ownerFile.writeFile(
          `${JSON.stringify({ schemaVersion: 1, owner, pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
          'utf8',
        )
        await ownerFile.sync()
      } finally {
        await ownerFile.close()
      }
      const { stdout } = await execFileAsync(
        this.#nvidiaSmiExecutable,
        ['--query-compute-apps=pid,process_name,used_gpu_memory', '--format=csv,noheader,nounits'],
        { encoding: 'utf8', maxBuffer: 64 * 1024, signal },
      )
      const active = stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)
      if (active.length > 0) {
        throw new SpeechEngineError(
          'gpu-busy',
          `GPU already has active compute processes; stop Gemma before Qwen3-TTS: ${active.join('; ')}`,
        )
      }
      return { release }
    } catch (error) {
      await release()
      if (signal?.aborted)
        throw new SpeechEngineError('cancelled', 'GPU lease acquisition was cancelled', {
          cause: error,
        })
      if (error instanceof SpeechEngineError) throw error
      throw new SpeechEngineError(
        'gpu-busy',
        'Could not verify exclusive GPU availability with nvidia-smi',
        { cause: error },
      )
    }
  }

  async #removeStaleLease(): Promise<boolean> {
    try {
      const owner = JSON.parse(
        await readFile(`${this.#lockDirectory}/owner.json`, 'utf8'),
      ) as Record<string, unknown>
      if (
        owner.schemaVersion !== 1 ||
        (owner.owner !== 'gemma' && owner.owner !== 'qwen3-tts') ||
        !Number.isInteger(owner.pid) ||
        (owner.pid as number) < 1
      ) {
        return false
      }
      try {
        process.kill(owner.pid as number, 0)
        return false
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false
      }
      await rm(this.#lockDirectory, { recursive: true, force: true })
      return true
    } catch {
      return false
    }
  }
}
