import { type ChildProcess, spawn } from 'node:child_process'
import { chmod, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import path from 'node:path'
import {
  type DirectorRuntimeLifecycle,
  SELECTED_GEMMA_PROFILE,
} from '@light-novel-audiobook/gemma-director'

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
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
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
  const deadline = Date.now() + options.timeoutMs
  while (Date.now() < deadline) {
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
 */
export class OwnedLlamaLifecycle implements DirectorRuntimeLifecycle {
  #child: ChildProcess | undefined
  #childError: Error | undefined
  #startPromise: Promise<void> | undefined
  #releasePromise: Promise<void> | undefined
  #cleanupComplete = false

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

  start(): Promise<void> {
    this.#startPromise ??= this.#startOnce()
    return this.#startPromise
  }

  async #startOnce(): Promise<void> {
    await writeFile(this.options.keyPath, `${this.options.apiKey}\n`, { flag: 'wx', mode: 0o600 })
    await chmod(this.options.keyPath, 0o600)
    const child = spawn(this.options.binaryPath, [...this.options.args], {
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

  release(): Promise<void> {
    this.#releasePromise ??= this.#releaseOnce()
    return this.#releasePromise
  }

  async #releaseOnce(): Promise<void> {
    const child = this.#child
    try {
      if (child !== undefined && !childExited(child)) {
        child.kill('SIGTERM')
        if (!(await waitForChildExit(child, this.options.terminateTimeoutMs ?? 15_000))) {
          child.kill('SIGKILL')
          if (!(await waitForChildExit(child, this.options.killTimeoutMs ?? 10_000))) {
            throw new Error('Owned llama-server did not exit after SIGKILL')
          }
        }
      }
    } finally {
      child?.removeAllListeners('error')
      await rm(this.options.keyPath, { force: true })
      await waitForPortFree(this.options.port, this.options.portFreeTimeoutMs ?? 10_000)
    }
    this.#cleanupComplete = true
  }
}

/** Filesystem layout of a built brain runtime, matching Gemma's real smoke exactly. */
export function llamaRuntimePaths(runtimeRoot: string): {
  readonly binaryPath: string
  readonly modelPath: string
} {
  return {
    binaryPath: path.join(runtimeRoot, 'llama.cpp/build/bin/llama-server'),
    modelPath: path.join(runtimeRoot, 'models', SELECTED_GEMMA_PROFILE.file),
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
    '--log-disable',
  ]
}
