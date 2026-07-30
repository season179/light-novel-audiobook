import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { LoadedProductionConfig } from './config.js'
import type { SegmentPlan } from './manifest.js'
import { recordRendered } from './manifest.js'
import type { QwenWorkerRuntimeIdentity } from './runtime-identity.js'
import type { SpeechProgressEvent, SpeechRenderOptions, SpeechSegmentResult } from './types.js'
import { SpeechEngineError } from './types.js'

const SHA256 = /^[0-9a-f]{64}$/
const MAX_PROTOCOL_LINE_BYTES = 64 * 1024
const MAX_STDERR_BYTES = 16 * 1024
const HEALTH_GATE_FATAL_STAGE = 'render-batch'
const HEALTH_GATE_FATAL_DETAIL = 'ValueError: generated WAV failed configured health gates'

interface WorkerEvent {
  readonly protocolVersion: number
  readonly type: string
  readonly segmentId?: string
  readonly sequence?: number
  readonly sha256?: string
  readonly message?: string
  readonly stage?: string
}

class ProgressCallbackError extends Error {
  override readonly name = 'ProgressCallbackError'
  readonly original: unknown

  constructor(original: unknown) {
    super('Qwen progress callback failed', { cause: original })
    this.original = original
  }
}

/**
 * Package-internal provenance marker. It is exported only for engine orchestration and deliberately
 * omitted from the package index: callers cannot manufacture retry eligibility by matching a
 * public error message. The frozen worker uses this one detail for all five WAV health gates
 * (duration cap, text-relative duration bounds, clipping, and active-frame fraction), so the
 * bounded retry policy necessarily covers their union.
 */
export class WorkerHealthGateError extends SpeechEngineError {
  constructor(segmentId: string) {
    super(
      'process-failed',
      `Qwen batch worker failed at ${HEALTH_GATE_FATAL_STAGE}: ${HEALTH_GATE_FATAL_DETAIL}`,
      { segmentId },
    )
  }
}

interface WorkerExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

export interface WorkerSessionConfig {
  readonly pythonExecutable: string
  readonly workerScriptPath: string
  readonly productionConfigPath: string
  readonly modelLockPath: string
  readonly runtimeManifestPath: string
  readonly uvLockPath: string
  readonly snapshotPath: string
  readonly outputDirectory: string
  readonly repositoryRoot: string
  readonly environment: Readonly<Record<string, string>>
  readonly cancellationGraceMs: number
  readonly allowOverwriteExisting: boolean
  readonly production: LoadedProductionConfig
  readonly runtimeIdentity: QwenWorkerRuntimeIdentity
}

function protocolError(message: string, segmentId?: string): SpeechEngineError {
  return new SpeechEngineError('protocol', `Qwen worker protocol error: ${message}`, {
    ...(segmentId === undefined ? {} : { segmentId }),
  })
}

export class QwenWorkerSession {
  readonly #config: WorkerSessionConfig
  readonly #options: SpeechRenderOptions
  readonly #child: ChildProcessWithoutNullStreams
  readonly #lines: AsyncIterator<string>
  readonly #exit: Promise<WorkerExit>
  readonly #cancel: () => void
  #stderr = ''
  #spawnError: unknown
  #closed = false
  #forceKill: NodeJS.Timeout | undefined

  private constructor(config: WorkerSessionConfig, options: SpeechRenderOptions) {
    this.#config = config
    this.#options = options
    const environment = { ...process.env, ...config.environment }
    delete environment.PYTHONHOME
    delete environment.PYTHONPATH
    delete environment.PYTHONSTARTUP
    Object.assign(environment, {
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      HF_DATASETS_OFFLINE: '1',
      PYTHONUNBUFFERED: '1',
      PYTHONNOUSERSITE: '1',
    })
    this.#child = spawn(config.pythonExecutable, [config.workerScriptPath], {
      cwd: config.repositoryRoot,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'] as const,
      env: environment,
      windowsHide: true,
    })

    // Install every lifecycle listener before invoking any caller callback.
    this.#exit = new Promise<WorkerExit>((resolveExit) => {
      this.#child.once('error', (error) => {
        this.#spawnError = error
      })
      this.#child.once('close', (code, signal) => {
        this.#closed = true
        resolveExit({ code, signal })
      })
    })
    this.#child.stdin.on('error', (error) => {
      this.#spawnError ??= error
    })
    this.#child.stderr.setEncoding('utf8')
    this.#child.stderr.on('data', (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-MAX_STDERR_BYTES)
    })
    this.#lines = createInterface({
      input: this.#child.stdout,
      crlfDelay: Number.POSITIVE_INFINITY,
    })[Symbol.asyncIterator]()
    this.#cancel = () => this.#terminate()
    options.signal?.addEventListener('abort', this.#cancel, { once: true })
    if (options.signal?.aborted) this.#terminate()
  }

  static async start(
    config: WorkerSessionConfig,
    options: SpeechRenderOptions,
    renderCount: number,
  ): Promise<QwenWorkerSession> {
    const session = new QwenWorkerSession(config, options)
    try {
      await session.#progress({ type: 'process-started', renderCount })
      await session.#send({
        protocolVersion: 1,
        command: 'begin-batch',
        productionConfigPath: config.productionConfigPath,
        productionConfigSha256: config.production.sha256,
        modelLockPath: config.modelLockPath,
        runtimeManifestPath: config.runtimeManifestPath,
        runtimeManifestSha256: config.runtimeIdentity.runtimeManifestSha256,
        uvLockPath: config.uvLockPath,
        snapshotPath: config.snapshotPath,
        outputDirectory: config.outputDirectory,
        workerSha256: config.runtimeIdentity.workerSha256,
        allowOverwriteExisting: config.allowOverwriteExisting,
      })
      await session.#expectProgress('runtime-validated', { type: 'runtime-validated' })
      await session.#expectProgress('model-loading', { type: 'model-loading' })
      await session.#expectProgress('model-loaded', { type: 'model-loaded' })
      return session
    } catch (error) {
      await session.abort()
      throw session.#classify(error)
    }
  }

  async render(plan: SegmentPlan): Promise<SpeechSegmentResult> {
    this.#assertUsable()
    try {
      await this.#send({
        protocolVersion: 1,
        command: 'render-segment',
        segment: {
          sequence: plan.sequence,
          segmentId: plan.request.segmentId,
          text: plan.request.text,
          voiceProfileId: plan.profile.id,
          seed: plan.seed,
          renderIdentitySha256: plan.identitySha256,
          applicationInputIdentity: plan.request.applicationInputIdentity ?? null,
          delivery: plan.delivery,
          effectiveInstruction: plan.effectiveInstruction,
          fallbackApproval: plan.request.fallbackApproval ?? null,
        },
      })
      const started = await this.#nextEvent()
      if (
        started.type !== 'segment-started' ||
        started.segmentId !== plan.request.segmentId ||
        started.sequence !== plan.sequence
      ) {
        throw protocolError('unexpected segment-started identity', started.segmentId)
      }
      await this.#progress({
        type: 'segment-started',
        segmentId: plan.request.segmentId,
        sequence: plan.sequence,
      })

      const rendered = await this.#nextEvent()
      if (
        rendered.type !== 'segment-rendered' ||
        rendered.segmentId !== plan.request.segmentId ||
        rendered.sequence !== plan.sequence ||
        typeof rendered.sha256 !== 'string' ||
        !SHA256.test(rendered.sha256)
      ) {
        throw protocolError('segment-rendered identity or hash mismatch', rendered.segmentId)
      }
      return await recordRendered(plan, this.#config.production, rendered.sha256)
    } catch (error) {
      await this.abort()
      throw this.#classify(error)
    }
  }

  async finish(): Promise<void> {
    // We closed the child ourselves when the caller cancelled; never report that as a crash.
    if (this.#options.signal?.aborted) {
      this.#terminate()
      await this.#exit
      this.#dispose()
      throw new SpeechEngineError('cancelled', 'Qwen render batch was cancelled')
    }
    if (this.#closed) {
      const exit = await this.#exit
      this.#dispose()
      if (exit.code === 0) return
      throw this.#processFailure(exit)
    }
    try {
      await this.#send({ protocolVersion: 1, command: 'end-batch' })
      this.#child.stdin.end()
      await this.#expectProgress('gpu-cleanup-complete', { type: 'gpu-cleanup-complete' })
      const complete = await this.#nextEvent()
      if (complete.type !== 'batch-complete') throw protocolError('worker omitted batch-complete')
      const exit = await this.#exit
      this.#dispose()
      if (exit.code !== 0) throw this.#processFailure(exit)
    } catch (error) {
      await this.abort()
      throw this.#classify(error)
    }
  }

  async abort(): Promise<void> {
    this.#terminate()
    await this.#exit
    this.#dispose()
  }

  async #expectProgress(
    expected: WorkerEvent['type'],
    progress: SpeechProgressEvent,
  ): Promise<void> {
    const event = await this.#nextEvent()
    if (event.type !== expected) throw protocolError(`expected ${expected}, received ${event.type}`)
    await this.#progress(progress)
  }

  async #nextEvent(): Promise<WorkerEvent> {
    const line = await this.#lines.next()
    if (line.done) {
      const exit = await this.#exit
      throw this.#processFailure(exit)
    }
    if (Buffer.byteLength(line.value) > MAX_PROTOCOL_LINE_BYTES) {
      throw protocolError('event line is too large')
    }
    // #62: skip blank lines only (empty or whitespace-only). A genuine protocol event always has
    // non-whitespace content, so this cannot swallow a malformed event -- it only absorbs a
    // library that prints a blank line to stdout (the protocol channel) during rendering.
    // Non-blank unparseable lines still throw below, so the strict parser is preserved.
    if (line.value.trim().length === 0) return await this.#nextEvent()
    let event: WorkerEvent
    try {
      event = JSON.parse(line.value) as WorkerEvent
    } catch {
      throw protocolError(`malformed JSON event: ${line.value.slice(0, 160)}`)
    }
    if (event.protocolVersion !== 1 || typeof event.type !== 'string') {
      throw protocolError('invalid event envelope')
    }
    if (event.type === 'fatal') {
      if (
        event.stage === HEALTH_GATE_FATAL_STAGE &&
        event.message === HEALTH_GATE_FATAL_DETAIL &&
        typeof event.segmentId === 'string'
      ) {
        throw new WorkerHealthGateError(event.segmentId)
      }
      throw new SpeechEngineError(
        'process-failed',
        `Qwen batch worker failed at ${event.stage ?? 'worker'}: ${event.message ?? 'unknown failure'}`,
        { ...(event.segmentId === undefined ? {} : { segmentId: event.segmentId }) },
      )
    }
    return event
  }

  async #send(value: unknown): Promise<void> {
    this.#assertUsable()
    await new Promise<void>((resolveWrite, reject) => {
      this.#child.stdin.write(`${JSON.stringify(value)}\n`, (error) => {
        if (error) reject(error)
        else resolveWrite()
      })
    })
  }

  async #progress(event: SpeechProgressEvent): Promise<void> {
    try {
      await this.#options.onProgress?.(event)
    } catch (error) {
      await this.abort()
      throw new ProgressCallbackError(error)
    }
  }

  #assertUsable(): void {
    if (this.#options.signal?.aborted) {
      this.#terminate()
      throw new SpeechEngineError('cancelled', 'Qwen render batch was cancelled')
    }
    if (this.#closed || this.#spawnError !== undefined) {
      throw new SpeechEngineError('process-failed', 'Pinned Qwen Python process is unavailable', {
        ...(this.#spawnError === undefined ? {} : { cause: this.#spawnError }),
      })
    }
  }

  #terminate(): void {
    if (this.#closed || this.#child.exitCode !== null || this.#child.signalCode !== null) return
    try {
      if (process.platform === 'win32' || this.#child.pid === undefined) this.#child.kill('SIGTERM')
      else process.kill(-this.#child.pid, 'SIGTERM')
    } catch {
      this.#child.kill('SIGTERM')
    }
    if (this.#forceKill === undefined) {
      this.#forceKill = setTimeout(() => {
        try {
          if (process.platform === 'win32' || this.#child.pid === undefined)
            this.#child.kill('SIGKILL')
          else process.kill(-this.#child.pid, 'SIGKILL')
        } catch {
          this.#child.kill('SIGKILL')
        }
      }, this.#config.cancellationGraceMs)
      this.#forceKill.unref()
    }
  }

  #classify(error: unknown): Error {
    if (this.#options.signal?.aborted) {
      return new SpeechEngineError('cancelled', 'Qwen render batch was cancelled', { cause: error })
    }
    if (error instanceof ProgressCallbackError) {
      if (error.original instanceof Error) return error.original
      return new SpeechEngineError('process-failed', 'Qwen progress callback failed', {
        cause: error.original,
      })
    }
    if (error instanceof SpeechEngineError) return error
    return new SpeechEngineError('process-failed', 'Qwen worker lifecycle failed', { cause: error })
  }

  #processFailure(exit: WorkerExit): SpeechEngineError {
    const details = this.#stderr.trim().slice(-2_000)
    return new SpeechEngineError(
      'process-failed',
      `Qwen batch worker exited before clean completion: ${details || this.#spawnError || `exit ${exit.code ?? exit.signal}`}`,
      { ...(this.#spawnError === undefined ? {} : { cause: this.#spawnError }) },
    )
  }

  #dispose(): void {
    if (this.#forceKill !== undefined) clearTimeout(this.#forceKill)
    this.#options.signal?.removeEventListener('abort', this.#cancel)
  }
}
