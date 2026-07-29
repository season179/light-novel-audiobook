import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  type HeldKernelLock,
  type KernelLockAcquireOptions,
  KernelLockError,
  type KernelLockStrategy,
} from './contracts.js'
import { resolveVerifiedDarwinHelper } from './helper-artifact.js'

export const DARWIN_KERNEL_LOCK_PROTOCOL = 'darwin-flock2-held-helper@1'
const OUTPUT_LIMIT = 4_000
const GROUP_POLL_MS = 20

interface HolderExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly error?: unknown
}

export interface DarwinHeldKernelLockStrategyConfig {
  readonly artifactDirectory?: string
  readonly compiler?: string
  readonly repositoryRoot?: string
  readonly releaseGraceMs?: number
  readonly killGraceMs?: number
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

/** Load-bearing: detachment is only legal after the helper's acquired handshake. */
function detachFromEventLoop(child: ChildProcessWithoutNullStreams): void {
  child.unref()
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    ;(stream as { unref?: () => void }).unref?.()
  }
}

export class DarwinHeldKernelLockStrategy implements KernelLockStrategy {
  readonly protocol = DARWIN_KERNEL_LOCK_PROTOCOL
  readonly #config: DarwinHeldKernelLockStrategyConfig

  constructor(config: DarwinHeldKernelLockStrategyConfig = {}) {
    this.#config = config
  }

  async acquire(options: KernelLockAcquireOptions): Promise<HeldKernelLock> {
    if (options.signal?.aborted)
      throw new KernelLockError('cancelled', 'Kernel-lock acquisition was cancelled')
    if (
      !Number.isInteger(options.conflictExitCode) ||
      options.conflictExitCode < 1 ||
      options.conflictExitCode > 255
    ) {
      throw new KernelLockError(
        'unavailable',
        'Kernel-lock conflict exit code must be between 1 and 255',
      )
    }
    if (
      options.acquisition.kind === 'bounded' &&
      (!Number.isFinite(options.acquisition.waitMs) || options.acquisition.waitMs < 0)
    ) {
      throw new KernelLockError('unavailable', 'Kernel-lock bounded wait must be non-negative')
    }
    const lockFilePath = resolve(options.lockFilePath)
    await mkdir(dirname(lockFilePath), { recursive: true, mode: 0o700 })
    const file = await open(lockFilePath, 'a', 0o600)
    await file.close()

    let helper: Awaited<ReturnType<typeof resolveVerifiedDarwinHelper>>
    try {
      helper = await resolveVerifiedDarwinHelper(this.#config)
    } catch (error) {
      throw new KernelLockError('unavailable', 'Darwin kernel-lock helper verification failed', {
        cause: error,
      })
    }
    if (helper.protocol !== this.protocol) {
      throw new KernelLockError('unavailable', 'Darwin kernel-lock helper protocol drifted')
    }

    const token = `${process.pid}-${crypto.randomUUID()}`
    const waitMs =
      options.acquisition.kind === 'bounded' ? Math.ceil(options.acquisition.waitMs) : 0
    const child = spawn(
      helper.path,
      [
        lockFilePath,
        options.acquisition.kind === 'bounded' ? 'bounded' : 'nonblock',
        String(waitMs),
        String(options.conflictExitCode),
        token,
        String(process.pid),
        this.protocol,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] as const, detached: true, windowsHide: true },
    )
    child.stdin.on('error', () => {})
    // Load-bearing: settle on exit, never close; the nested holder inherits stdio.
    const exit = new Promise<HolderExit>((resolveExit) => {
      let settled = false
      const settle = (result: HolderExit): void => {
        if (settled) return
        settled = true
        resolveExit(result)
      }
      child.once('error', (error) => settle({ code: null, signal: null, error }))
      child.once('exit', (code, signal) => settle({ code, signal }))
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-OUTPUT_LIMIT)
    })
    const cancel = (): void => this.#signalSubtree(child, 'SIGTERM')
    options.signal?.addEventListener('abort', cancel, { once: true })
    let acquired = false
    try {
      const handshake = await this.#handshake(child, exit, token)
      if (handshake.state === 'exited') {
        const result = await exit
        if (options.signal?.aborted)
          throw new KernelLockError('cancelled', 'Kernel-lock acquisition was cancelled')
        if (result.code === options.conflictExitCode) {
          throw new KernelLockError('busy', `Kernel lock is already held: ${lockFilePath}`)
        }
        throw new KernelLockError(
          'unavailable',
          `Darwin kernel-lock helper failed: ${stderr.trim() || result.error || `exit ${result.code}`}`,
        )
      }
      if (handshake.state === 'unusable' || handshake.holderPid === undefined) {
        throw new KernelLockError(
          'unavailable',
          'Darwin kernel-lock helper produced an unusable handshake',
        )
      }
      if (options.signal?.aborted)
        throw new KernelLockError('cancelled', 'Kernel-lock acquisition was cancelled')
      acquired = true
      const groupPid = child.pid
      const holderPid = handshake.holderPid
      if (groupPid === undefined)
        throw new KernelLockError(
          'unavailable',
          'Darwin kernel-lock helper process group is unavailable',
        )
      detachFromEventLoop(child)
      let released = false
      return {
        protocol: this.protocol,
        assertHeld: () => {
          if (released) throw new KernelLockError('unavailable', 'Kernel lock was already released')
          // Fail closed on every probe result except ESRCH; EPERM still proves existence.
          if (!processAlive(holderPid) || !processGroupAlive(groupPid)) {
            throw new KernelLockError(
              'unavailable',
              `Kernel lock holder for ${lockFilePath} is gone`,
            )
          }
        },
        release: async () => {
          if (released) return
          released = true
          child.ref()
          if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end()
          const releaseGraceMs = this.#config.releaseGraceMs ?? 5_000
          if (await this.#waitForGone(groupPid, exit, releaseGraceMs)) return
          signalGroup(groupPid, 'SIGKILL')
          const killGraceMs = this.#config.killGraceMs ?? 5_000
          if (!(await this.#waitForGone(groupPid, exit, killGraceMs))) {
            throw new KernelLockError(
              'unavailable',
              `Kernel-lock holder group ${groupPid} survived SIGKILL`,
            )
          }
          throw new KernelLockError(
            'unavailable',
            `Kernel-lock holder group ${groupPid} required SIGKILL during release`,
          )
        },
      }
    } catch (error) {
      if (acquired || child.pid !== undefined) await this.#stopQuietly(child, exit)
      if (error instanceof KernelLockError) throw error
      throw new KernelLockError(
        options.signal?.aborted ? 'cancelled' : 'unavailable',
        'Could not acquire Darwin kernel lock',
        { cause: error },
      )
    } finally {
      options.signal?.removeEventListener('abort', cancel)
    }
  }

  async #handshake(
    child: ChildProcessWithoutNullStreams,
    exit: Promise<HolderExit>,
    token: string,
  ): Promise<{ readonly state: 'acquired' | 'exited' | 'unusable'; readonly holderPid?: number }> {
    child.stdout.setEncoding('utf8')
    return await new Promise((resolveHandshake) => {
      let settled = false
      let output = ''
      const finish = (value: {
        readonly state: 'acquired' | 'exited' | 'unusable'
        readonly holderPid?: number
      }): void => {
        if (settled) return
        settled = true
        resolveHandshake(value)
      }
      child.stdout.on('data', (chunk: string) => {
        output += chunk
        const line = output.split(/\r?\n/u).find((candidate) => candidate.startsWith(`${token} `))
        if (line !== undefined) {
          const [pidText, protocol] = line
            .slice(token.length + 1)
            .trim()
            .split(/\s+/u)
          const holderPid = Number(pidText)
          if (Number.isSafeInteger(holderPid) && holderPid > 1 && protocol === this.protocol)
            finish({ state: 'acquired', holderPid })
          else finish({ state: 'unusable' })
        }
        if (output.length > OUTPUT_LIMIT) finish({ state: 'unusable' })
      })
      void exit.then(() => finish({ state: 'exited' }))
    })
  }

  #signalSubtree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
    try {
      child.kill(signal)
    } catch {}
    if (child.pid !== undefined) {
      try {
        signalGroup(child.pid, signal)
      } catch {}
    }
  }

  async #stopQuietly(
    child: ChildProcessWithoutNullStreams,
    exit: Promise<HolderExit>,
  ): Promise<void> {
    try {
      child.ref()
      if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end()
      if (child.pid === undefined) return
      if (await this.#waitForGone(child.pid, exit, 1_000)) return
      signalGroup(child.pid, 'SIGKILL')
      await this.#waitForGone(child.pid, exit, 1_000)
    } catch {}
  }

  async #waitForGone(
    groupPid: number,
    exit: Promise<HolderExit>,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = performance.now() + timeoutMs
    let directExited = false
    void exit.then(() => {
      directExited = true
    })
    for (;;) {
      if (directExited && !processGroupAlive(groupPid)) return true
      if (performance.now() >= deadline) return false
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, GROUP_POLL_MS))
    }
  }
}
