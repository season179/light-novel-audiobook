import { type ChildProcess, spawn } from 'node:child_process'
import { chmod, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import type { DirectorRuntimeLifecycle } from './port.js'
import { SELECTED_GEMMA_PROFILE } from './profile.js'

export interface OwnedLlamaLifecycleOptions {
  readonly binaryPath: string
  readonly args: readonly string[]
  /** Written to `keyPath` at 0600 for `--api-key-file`, so the key never appears in argv. */
  readonly apiKey: string
  readonly keyPath: string
  readonly origin: string
  readonly port: number
  readonly startupTimeoutMs: number
  readonly terminateTimeoutMs?: number
  readonly killTimeoutMs?: number
  readonly portFreeTimeoutMs?: number
  /**
   * Bounded wait for an in-flight `start()` to settle once `release()` has begun.
   *
   * Release reaps the child before it waits, so a startup blocked polling `/health` notices its
   * process is gone within one poll interval; this bound only covers a startup wedged somewhere
   * release cannot unstick it, such as a hung filesystem write. Expiry is a release failure, never
   * a quiet success — see `#awaitStartupSettled`.
   */
  readonly startupSettleTimeoutMs?: number
}

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

/** True once `settling` has settled either way, false if the bound expired first. */
async function settledWithin(settling: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      settling.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function portIsFree(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise) => {
    const server = createServer()
    server.once('error', () => resolvePromise(false))
    server.listen(port, '127.0.0.1', () => {
      server.close((error) => resolvePromise(error === undefined))
    })
  })
}

async function waitForPortFree(port: number, timeoutMs: number): Promise<void> {
  const startedAt = performance.now()
  while (performance.now() - startedAt < timeoutMs) {
    if (await portIsFree(port)) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
  }
  throw new Error('Owned llama-server did not release its configured port')
}

async function waitForHealth(options: {
  readonly origin: string
  readonly apiKey: string
  readonly child: ChildProcess
  readonly childError: () => Error | undefined
  readonly timeoutMs: number
}): Promise<void> {
  const startedAt = performance.now()
  while (performance.now() - startedAt < options.timeoutMs) {
    const emittedError = options.childError()
    if (emittedError) throw new Error('Owned llama-server failed to spawn', { cause: emittedError })
    if (childExited(options.child)) throw new Error('Owned llama-server exited during model load')
    try {
      const response = await fetch(`${options.origin}/health`, {
        headers: { authorization: `Bearer ${options.apiKey}` },
        signal: AbortSignal.timeout(2_000),
      })
      if (response.ok) return
    } catch {
      // Expected while the owned model process is loading.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
  throw new Error('Owned llama-server did not become healthy before the startup deadline')
}

/** Owns llama.cpp for exactly the span of the director's GPU lease. */
export class OwnedLlamaLifecycle implements DirectorRuntimeLifecycle {
  #child: ChildProcess | undefined
  #childError: Error | undefined
  #startPromise: Promise<void> | undefined
  #releasePromise: Promise<void> | undefined
  #releasing = false
  #cleanupComplete = false

  constructor(private readonly options: OwnedLlamaLifecycleOptions) {}

  get processId(): number | undefined {
    return this.#child?.pid
  }

  get running(): boolean {
    const child = this.#child
    return child !== undefined && !childExited(child)
  }

  get cleanupComplete(): boolean {
    return this.#cleanupComplete
  }

  start(): Promise<void> {
    this.#startPromise ??= this.#startOnce()
    return this.#startPromise
  }

  async #startOnce(): Promise<void> {
    this.#assertSpawnStillAllowed()
    await writeFile(this.options.keyPath, `${this.options.apiKey}\n`, { flag: 'wx', mode: 0o600 })
    await chmod(this.options.keyPath, 0o600)
    // Read and coerce every caller-controlled spawn operand before the final synchronous check.
    // Accessors, iterators, and coercions can run caller code, including a re-entrant release().
    const binaryPath = String(this.options.binaryPath)
    const args = Array.from(this.options.args, (arg) => String(arg))
    this.#assertSpawnStillAllowed()
    const child = spawn(binaryPath, args, {
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    this.#child = child
    child.on('error', (error: Error) => {
      this.#childError = error
    })
    await waitForHealth({
      origin: this.options.origin,
      apiKey: this.options.apiKey,
      child,
      childError: () => this.#childError,
      timeoutMs: this.options.startupTimeoutMs,
    })
  }

  #assertSpawnStillAllowed(): void {
    if (this.#releasing) {
      throw new Error('Owned llama-server start was abandoned because release had already begun')
    }
  }

  release(): Promise<void> {
    this.#releasePromise ??= this.#releaseOnce()
    return this.#releasePromise
  }

  async #releaseOnce(): Promise<void> {
    // Set synchronously before the first await; no later spawn may cross the matching assertion.
    this.#releasing = true
    try {
      // Reap first so a startup polling health observes its child gone and settles quickly.
      await this.#reapChild()
      await this.#awaitStartupSettled()
      // Reap again in case startup spawned between the first snapshot and settlement.
      await this.#reapChild()
    } finally {
      this.#child?.removeAllListeners('error')
      await rm(this.options.keyPath, { force: true })
    }
    await waitForPortFree(this.options.port, this.options.portFreeTimeoutMs ?? 10_000)
    this.#cleanupComplete = true
  }

  async #reapChild(): Promise<void> {
    const child = this.#child
    if (child === undefined || childExited(child)) return
    child.kill('SIGTERM')
    if (await waitForChildExit(child, this.options.terminateTimeoutMs ?? 15_000)) return
    child.kill('SIGKILL')
    if (!(await waitForChildExit(child, this.options.killTimeoutMs ?? 10_000))) {
      throw new Error('Owned llama-server did not exit after SIGKILL')
    }
  }

  async #awaitStartupSettled(): Promise<void> {
    const startPromise = this.#startPromise
    if (startPromise === undefined) return
    const timeoutMs = this.options.startupSettleTimeoutMs ?? 30_000
    if (await settledWithin(startPromise, timeoutMs)) return
    throw new Error(
      `Owned llama-server startup had not settled ${timeoutMs}ms after release began, so the runtime cannot be reported gone`,
    )
  }
}

export function llamaRuntimePaths(runtimeRoot: string): {
  readonly binaryPath: string
  readonly modelPath: string
} {
  return {
    binaryPath: join(runtimeRoot, 'llama.cpp/build/bin/llama-server'),
    modelPath: join(runtimeRoot, 'models', SELECTED_GEMMA_PROFILE.file),
  }
}

export function llamaServerArgs(options: {
  readonly modelPath: string
  readonly host: string
  readonly port: number
  readonly keyPath: string
}): readonly string[] {
  return [
    '--model',
    options.modelPath,
    '--alias',
    SELECTED_GEMMA_PROFILE.modelId,
    '--host',
    options.host,
    '--port',
    String(options.port),
    '--ctx-size',
    String(SELECTED_GEMMA_PROFILE.contextSize),
    '--parallel',
    '1',
    '--n-gpu-layers',
    String(SELECTED_GEMMA_PROFILE.gpuLayers),
    '--cache-type-k',
    SELECTED_GEMMA_PROFILE.cacheTypeK,
    '--cache-type-v',
    SELECTED_GEMMA_PROFILE.cacheTypeV,
    '--flash-attn',
    'on',
    '--batch-size',
    String(SELECTED_GEMMA_PROFILE.batchSize),
    '--ubatch-size',
    String(SELECTED_GEMMA_PROFILE.microBatchSize),
    '--threads',
    String(SELECTED_GEMMA_PROFILE.threads),
    '--reasoning',
    SELECTED_GEMMA_PROFILE.reasoning,
    '--no-cache-prompt',
    '--api-key-file',
    options.keyPath,
    '--cors-origins',
    'localhost',
    '--no-cors-credentials',
    '--no-webui',
    '--metrics',
    '--slots',
    '--log-disable',
  ]
}
