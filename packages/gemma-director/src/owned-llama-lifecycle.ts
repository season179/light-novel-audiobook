import { type ChildProcess, spawn } from 'node:child_process'
import { chmod, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { BoundedProcessCapture } from './bounded-process-capture.js'
import type { DirectorRuntimeLifecycle } from './port.js'
import { SELECTED_GEMMA_PROFILE } from './profile.js'

export interface OwnedLlamaLifecycleOptions {
  readonly binaryPath: string
  readonly args: readonly string[]
  /** Written to `keyPath` at 0600 for `--api-key-file`, so the key never appears in argv. */
  readonly apiKey: string
  readonly keyPath: string
  /** Durable, bounded stdout/stderr capture for this lifecycle; defaults beside the key file. */
  readonly capturePath?: string
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
   * release cannot unstick it, such as a hung filesystem write. Expiry is a release *failure*, never
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

/**
 * True once `settling` has settled either way, false if the bound expired first. Rejections count as
 * settled: the rejection belongs to whoever called the operation, not to the code waiting for it to
 * be over. The timer is cleared but never unref'd, so a wait here cannot be cut short by an
 * otherwise-idle event loop.
 */
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

/**
 * Owns the llama.cpp process for exactly the span of the director's GPU lease.
 *
 * This has to be a real lifecycle, not a recorder. `GemmaDirectorModel` calls `start()` only while it
 * already holds the exclusive lease and `release()` before the lease is dropped, so implementing those
 * as process spawn and process reap is what makes VRAM residency inseparable from the lease. A
 * recording no-op satisfies the *type* while leaving Gemma resident: the lease would then be handed to
 * Qwen, which loads 16 GB beside a model that never unloaded, and the first real run OOMs.
 *
 * `release()` therefore does not return until the process has actually exited and its port is free.
 * Those are the two externally observable facts a caller can check; neither can be faked by bookkeeping.
 *
 * That promise has to hold against a *concurrent* `release()`, not just a sequential one. A start that
 * has not settled is a start that may still be about to put weights in VRAM: it may be inside the
 * pre-spawn key-file writes with no child to find yet, one statement away from `spawn`. So release
 * both waits for startup to settle and permanently prohibits a spawn from that moment on. Checking for
 * a child once and returning would report the runtime gone while it was still arriving.
 */
export class OwnedLlamaLifecycle implements DirectorRuntimeLifecycle {
  #child: ChildProcess | undefined
  #childError: Error | undefined
  #startPromise: Promise<void> | undefined
  #releasePromise: Promise<void> | undefined
  #childCaptureClosed: Promise<void> | undefined
  #releasing = false
  #cleanupComplete = false
  #capture: BoundedProcessCapture | undefined

  constructor(private readonly options: OwnedLlamaLifecycleOptions) {}

  /** The owned process ID while it exists, so a caller can probe the kernel for it directly. */
  get processId(): number | undefined {
    return this.#child?.pid
  }

  /** True only between a successful spawn and the process actually exiting. */
  get running(): boolean {
    const child = this.#child
    return child !== undefined && !childExited(child)
  }

  get cleanupComplete(): boolean {
    return this.#cleanupComplete
  }

  get capturePath(): string {
    return this.#processCapture().path
  }

  start(): Promise<void> {
    this.#startPromise ??= this.#startOnce()
    return this.#startPromise
  }

  async #startOnce(): Promise<void> {
    // Keep this check before even reading capture/key path accessors. `release()` closes the spawn
    // gate synchronously, and hostile-but-type-valid getters must not reopen the old race window.
    this.#assertSpawnStillAllowed()
    const capture = this.#processCapture()
    capture.mark('starting')
    void capture.persist()
    try {
      await this.#startAndWaitForHealth(capture)
    } catch (error) {
      capture.mark('startup_failed')
      void capture.persist()
      throw error
    }
  }

  #processCapture(): BoundedProcessCapture {
    this.#capture ??= new BoundedProcessCapture(
      this.options.capturePath ?? `${this.options.keyPath}.log`,
    )
    return this.#capture
  }

  async #startAndWaitForHealth(capture: BoundedProcessCapture): Promise<void> {
    this.#assertSpawnStillAllowed()
    await writeFile(this.options.keyPath, `${this.options.apiKey}\n`, { flag: 'wx', mode: 0o600 })
    await chmod(this.options.keyPath, 0o600)
    // Every spawn operand is read and coerced to a primitive *before* the final check, so the check and
    // the spawn are separated by nothing the caller can hook. `OwnedLlamaLifecycleOptions` is an
    // interface: these properties may legally be accessors, `args` may be any iterable, and a value may
    // carry a `toString`. Reading them after the check would run caller code inside the one window that
    // has to be closed — and a `binaryPath` getter that calls `release()` provably spawned a child after
    // release had begun. The coercions look redundant against the declared types on purpose; the types
    // are a promise from the caller, and this window is exactly where that promise must not be trusted.
    const binaryPath = String(this.options.binaryPath)
    const args = Array.from(this.options.args, (arg) => String(arg))
    this.#assertSpawnStillAllowed()
    const child = spawn(binaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.#child = child
    // Attach consumers synchronously with spawn. Even after the 1 MiB capture bound is reached both
    // streams continue to drain, so llama-server can never block on a full OS pipe.
    child.stdout?.on('data', (chunk: Buffer) => capture.append('stdout', chunk))
    child.stderr?.on('data', (chunk: Buffer) => capture.append('stderr', chunk))
    this.#childCaptureClosed = new Promise<void>((resolveCaptureClosed) => {
      child.once('close', (code, signal) => {
        capture.append('lifecycle', `exit_code=${code ?? 'null'} signal=${signal ?? 'null'}`)
        capture.mark('exited')
        void capture.persist()
        resolveCaptureClosed()
      })
    })
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
    capture.mark('healthy')
    void capture.persist()
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
    // Assigned before the first await, so it is set synchronously with the `release()` call itself and
    // no `spawn` can be reached after it. This is the flag `#assertSpawnStillAllowed` reads.
    this.#releasing = true
    try {
      // Reap before waiting. A startup polling `/health` sees its child gone within one poll interval
      // and fails, so awaiting settlement below cannot stall for the whole startup deadline.
      await this.#reapChild()
      await this.#awaitStartupSettled()
      // Startup has settled and can no longer spawn, so this catches a child created in the window
      // between the reap above and settlement — the one the old single snapshot of `#child` missed.
      await this.#reapChild()
    } finally {
      this.#child?.removeAllListeners('error')
      // The per-run secret goes whatever else happened; a surviving 0600 key file is still a leak.
      await rm(this.options.keyPath, { force: true })
    }
    await waitForPortFree(this.options.port, this.options.portFreeTimeoutMs ?? 10_000)
    await settledWithin(this.#childCaptureClosed ?? Promise.resolve(), 500)
    const capture = this.#processCapture()
    void capture.persist()
    // A slow or failed diagnostic filesystem cannot hold the GPU lease indefinitely. The write
    // continues in Node's fs queue, while lifecycle success depends only on process/port cleanup.
    await settledWithin(capture.settled(), 500)
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

  /**
   * The half of the contract that used to be missing. A failed start counts as settled — its rejection
   * is the `start()` caller's to handle, and a start that failed is a start that will never spawn.
   *
   * The wait is bounded so a genuinely wedged startup cannot turn a co-residency bug into a hang. But
   * expiry means the runtime's state is *unknown*, so it throws rather than resolving: `cleanupComplete`
   * stays false and the caller must fail closed instead of handing the GPU on.
   */
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

/** Filesystem layout of a built brain runtime, matching Gemma's real smoke exactly. */
export function llamaRuntimePaths(runtimeRoot: string): {
  readonly binaryPath: string
  readonly modelPath: string
} {
  return {
    binaryPath: join(runtimeRoot, 'llama.cpp/build/bin/llama-server'),
    modelPath: join(runtimeRoot, 'models', SELECTED_GEMMA_PROFILE.file),
  }
}

/**
 * The pinned server arguments for the selected profile. Every value comes from
 * `SELECTED_GEMMA_PROFILE` rather than being restated here, so the driver cannot drift from the
 * profile the director adapter validates against.
 */
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
  ]
}
