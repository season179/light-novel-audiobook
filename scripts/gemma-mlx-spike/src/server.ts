import { type ChildProcess, spawn } from 'node:child_process'
import { createWriteStream, type WriteStream } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { processFamilySnapshot, waitForPortFree } from './collectors.js'

export interface OwnedMlxServerOptions {
  readonly serverBin: string
  readonly args: readonly string[]
  readonly host: string
  readonly port: number
  /** Bounded stdout/stderr capture lives beside the evidence, outside the repo. */
  readonly logPath: string
  readonly terminateTimeoutMs: number
  readonly killTimeoutMs: number
  readonly portFreeTimeoutMs: number
}

export interface CleanupReport {
  readonly terminatedWith: 'already-exited' | 'sigterm' | 'sigkill'
  readonly exitCode: number | null
  readonly exitSignal: string | null
  readonly shutdownMs: number
  readonly descendantsRemaining: readonly number[]
  readonly portFree: boolean
  readonly cleanupVerified: boolean
}

const LOG_CAPTURE_LIMIT_BYTES = 4 * 1024 * 1024

function childExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childExited(child)) return true
  return await new Promise<boolean>((resolvePromise) => {
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      resolvePromise(value)
    }
    const onExit = (): void => finish(true)
    const timer = setTimeout(() => finish(childExited(child)), timeoutMs)
    child.once('exit', onExit)
  })
}

/**
 * Owns the mlx_lm.server process for exactly one spike run. The server is spawned detached so it
 * leads its own process group: shutdown signals the whole group (SIGTERM, then a bounded SIGKILL
 * fallback), then proves descendant exit and port release before reporting cleanup complete.
 *
 * The run is not clean until no owned process/descendant remains and the pinned port is free;
 * anything less throws/fails closed rather than reporting success.
 */
export class OwnedMlxServer {
  #child: ChildProcess | undefined
  #spawnError: Error | undefined
  #shutdownPromise: Promise<CleanupReport> | undefined
  #logStream: WriteStream | undefined
  #logBytes = 0
  #exitCode: number | null = null
  #exitSignal: string | null = null

  constructor(private readonly options: OwnedMlxServerOptions) {}

  get processId(): number | undefined {
    return this.#child?.pid
  }

  get running(): boolean {
    const child = this.#child
    return child !== undefined && !childExited(child)
  }

  /** Synchronous best-effort kill for crash paths; normal cleanup goes through shutdown(). */
  forceKillGroupSync(): void {
    const pid = this.#child?.pid
    if (pid === undefined || this.#child === undefined || childExited(this.#child)) return
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }

  start(): void {
    if (this.#child !== undefined) throw new Error('Owned mlx_lm.server was already started')
    this.#logStream = createWriteStream(this.options.logPath, { flags: 'wx' })
    const child = spawn(this.options.serverBin, [...this.options.args], {
      // New process group: the group kill below then covers any descendant the server spawns.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.#child = child
    const append = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (this.#logStream === undefined) return
      if (this.#logBytes >= LOG_CAPTURE_LIMIT_BYTES) return // keep draining; stop appending
      this.#logBytes += chunk.length
      this.#logStream.write(`[${stream}] `)
      this.#logStream.write(chunk)
    }
    // Consumers attach synchronously with spawn so the server can never block on a full pipe.
    child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk))
    child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk))
    child.once('close', (code, signal) => {
      this.#exitCode = code
      this.#exitSignal = signal
      this.#logStream?.end(`[lifecycle] exit_code=${code ?? 'null'} signal=${signal ?? 'null'}\n`)
      this.#logStream = undefined
    })
    child.on('error', (error: Error) => {
      this.#spawnError = error
    })
  }

  /**
   * Resolves once the pinned port accepts a TCP connection from this owner. This is listener
   * readiness only: mlx_lm.server answers /health unconditionally and loads the model lazily on
   * the first request, so this must never be reported as model load.
   */
  async waitForListener(timeoutMs: number): Promise<{ listenerReadyMs: number }> {
    const startedAt = performance.now()
    while (performance.now() - startedAt < timeoutMs) {
      if (this.#spawnError !== undefined) {
        throw new Error('Owned mlx_lm.server failed to spawn', { cause: this.#spawnError })
      }
      const child = this.#child
      if (child === undefined) throw new Error('Owned mlx_lm.server was not started')
      if (childExited(child)) {
        throw new Error(
          `Owned mlx_lm.server exited during startup (code=${this.#exitCode ?? 'null'} ` +
            `signal=${this.#exitSignal ?? 'null'}); see ${this.options.logPath}`,
        )
      }
      const reachable = await new Promise<boolean>((resolvePromise) => {
        const socket = connect({ host: this.options.host, port: this.options.port })
        socket.once('connect', () => {
          socket.destroy()
          resolvePromise(true)
        })
        socket.once('error', () => {
          socket.destroy()
          resolvePromise(false)
        })
        socket.setTimeout(1_000, () => {
          socket.destroy()
          resolvePromise(false)
        })
      })
      if (reachable) {
        return { listenerReadyMs: Math.round(performance.now() - startedAt) }
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    }
    throw new Error('Owned mlx_lm.server did not open its listener before the startup deadline')
  }

  /**
   * SIGTERM to the owned process group, bounded SIGKILL fallback, then proof of descendant exit
   * and port release. Idempotent; never reports success while a descendant or the port remains.
   */
  shutdown(): Promise<CleanupReport> {
    this.#shutdownPromise ??= this.#shutdownOnce()
    return this.#shutdownPromise
  }

  async #shutdownOnce(): Promise<CleanupReport> {
    const startedAt = performance.now()
    const child = this.#child
    let terminatedWith: CleanupReport['terminatedWith'] = 'already-exited'
    if (child !== undefined && !childExited(child)) {
      const pid = child.pid
      const signalGroup = (signal: 'SIGTERM' | 'SIGKILL'): void => {
        if (pid === undefined) return
        try {
          // Negative pid targets the whole detached process group (server + descendants).
          process.kill(-pid, signal)
        } catch {
          // Group already gone.
        }
      }
      signalGroup('SIGTERM')
      terminatedWith = 'sigterm'
      if (!(await waitForChildExit(child, this.options.terminateTimeoutMs))) {
        signalGroup('SIGKILL')
        terminatedWith = 'sigkill'
        if (!(await waitForChildExit(child, this.options.killTimeoutMs))) {
          throw new Error('Owned mlx_lm.server did not exit after SIGKILL')
        }
      }
    }
    const pid = child?.pid
    const descendants =
      pid === undefined ? [] : (await processFamilySnapshot(pid)).pids
    const portFree = await waitForPortFree(
      this.options.host,
      this.options.port,
      this.options.portFreeTimeoutMs,
    )
    return {
      terminatedWith,
      exitCode: this.#exitCode,
      exitSignal: this.#exitSignal,
      shutdownMs: Math.round(performance.now() - startedAt),
      descendantsRemaining: descendants,
      portFree,
      cleanupVerified: descendants.length === 0 && portFree,
    }
  }
}

export function serverLogPath(outDir: string): string {
  return join(outDir, 'mlx-lm-server.log')
}
