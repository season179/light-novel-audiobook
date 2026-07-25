import { spawn } from 'node:child_process'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { LoadedProductionConfig } from './config.js'
import { loadProductionConfig } from './config.js'
import type { SegmentPlan } from './manifest.js'
import { canonicalJson, createSegmentPlan, recordRendered, sha256, tryReuse } from './manifest.js'
import type {
  ExclusiveGpuGate,
  GpuLease,
  SpeechBatchResult,
  SpeechEngine,
  SpeechProgressEvent,
  SpeechRenderOptions,
  SpeechSegmentRequest,
  SpeechSegmentResult,
} from './types.js'
import { SpeechEngineError } from './types.js'

const SEGMENT_ID = /^(?:ch[0-9]+-[0-9]+|book-[0-9a-f]{24}-ch[0-9]{4}-p[0-9]{6}-s[0-9]{4})$/
const SHA256 = /^[0-9a-f]{64}$/
const MAX_PROTOCOL_LINE_BYTES = 64 * 1024
const MAX_STDERR_BYTES = 16 * 1024

export interface QwenTtsEngineConfig {
  readonly pythonExecutable: string
  readonly workerScriptPath: string
  readonly productionConfigPath: string
  readonly modelLockPath: string
  readonly runtimeManifestPath: string
  readonly uvLockPath: string
  readonly snapshotPath: string
  readonly outputDirectory: string
  readonly repositoryRoot: string
  readonly gpuGate: ExclusiveGpuGate
  readonly processEnvironment?: Readonly<Record<string, string>>
  readonly cancellationGraceMs?: number
}

interface WorkerEvent {
  readonly protocolVersion: number
  readonly type: string
  readonly segmentId?: string
  readonly sequence?: number
  readonly sha256?: string
  readonly message?: string
  readonly stage?: string
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

async function regularFile(path: string, label: string): Promise<void> {
  try {
    const info = await lstat(path)
    if (!info.isFile()) throw new Error('not a regular file')
  } catch (error) {
    throw new SpeechEngineError('configuration', `${label} is unavailable: ${path}`, {
      cause: error,
    })
  }
}

function validateRequests(segments: ReadonlyArray<SpeechSegmentRequest>): void {
  const ids = new Set<string>()
  for (const segment of segments) {
    if (!SEGMENT_ID.test(segment.segmentId)) {
      throw new SpeechEngineError(
        'configuration',
        `Unsafe or noncanonical segment ID: ${segment.segmentId}`,
        { segmentId: segment.segmentId },
      )
    }
    if (ids.has(segment.segmentId)) {
      throw new SpeechEngineError('configuration', `Duplicate segment ID: ${segment.segmentId}`, {
        segmentId: segment.segmentId,
      })
    }
    ids.add(segment.segmentId)
    if (
      segment.text.length === 0 ||
      segment.text.trim().length === 0 ||
      segment.text.includes('\0')
    ) {
      throw new SpeechEngineError(
        'configuration',
        `Segment ${segment.segmentId} has invalid render text`,
        {
          segmentId: segment.segmentId,
        },
      )
    }
  }
}

function emit(options: SpeechRenderOptions, event: SpeechProgressEvent): void {
  options.onProgress?.(event)
}

function protocolError(message: string, segmentId?: string): SpeechEngineError {
  return new SpeechEngineError('protocol', `Qwen worker protocol error: ${message}`, {
    ...(segmentId === undefined ? {} : { segmentId }),
  })
}

export class QwenTtsSpeechEngine implements SpeechEngine {
  readonly identity: string
  readonly #paths: Omit<
    QwenTtsEngineConfig,
    'gpuGate' | 'processEnvironment' | 'cancellationGraceMs'
  >
  readonly #gpuGate: ExclusiveGpuGate
  readonly #environment: Readonly<Record<string, string>>
  readonly #cancellationGraceMs: number
  readonly #production: LoadedProductionConfig

  private constructor(config: QwenTtsEngineConfig, production: LoadedProductionConfig) {
    this.#paths = {
      pythonExecutable: resolve(config.pythonExecutable),
      workerScriptPath: resolve(config.workerScriptPath),
      productionConfigPath: resolve(config.productionConfigPath),
      modelLockPath: resolve(config.modelLockPath),
      runtimeManifestPath: resolve(config.runtimeManifestPath),
      uvLockPath: resolve(config.uvLockPath),
      snapshotPath: resolve(config.snapshotPath),
      outputDirectory: resolve(config.outputDirectory),
      repositoryRoot: resolve(config.repositoryRoot),
    }
    this.#gpuGate = config.gpuGate
    this.#environment = config.processEnvironment ?? {}
    this.#cancellationGraceMs = config.cancellationGraceMs ?? 5_000
    this.#production = production
    this.identity = sha256(
      canonicalJson({
        adapter: production.value.adapter,
        model: production.value.model,
        runtime: production.value.runtime,
        generation: production.value.generation,
        seedStrategy: production.value.seedStrategy,
      }),
    )
  }

  static async create(config: QwenTtsEngineConfig): Promise<QwenTtsSpeechEngine> {
    if (
      !Number.isInteger(config.cancellationGraceMs ?? 5_000) ||
      (config.cancellationGraceMs ?? 5_000) < 100
    ) {
      throw new SpeechEngineError('configuration', 'cancellationGraceMs must be at least 100 ms')
    }
    const filePaths = [
      [config.pythonExecutable, 'Pinned Python executable'],
      [config.workerScriptPath, 'Qwen batch worker'],
      [config.productionConfigPath, 'Qwen production configuration'],
      [config.modelLockPath, 'Qwen model lock'],
      [config.runtimeManifestPath, 'Qwen runtime manifest'],
      [config.uvLockPath, 'Qwen uv lock'],
    ] as const
    await Promise.all(filePaths.map(([path, label]) => regularFile(resolve(path), label)))
    const production = await loadProductionConfig(resolve(config.productionConfigPath))
    await mkdir(resolve(config.outputDirectory), { recursive: true, mode: 0o700 })
    const [repositoryRoot, outputDirectory, snapshotPath] = await Promise.all([
      realpath(resolve(config.repositoryRoot)),
      realpath(resolve(config.outputDirectory)),
      realpath(resolve(config.snapshotPath)),
    ])
    if (contains(repositoryRoot, outputDirectory) || contains(outputDirectory, repositoryRoot)) {
      throw new SpeechEngineError(
        'configuration',
        'Qwen output directory must be outside the Git worktree',
      )
    }
    if (contains(snapshotPath, outputDirectory) || contains(outputDirectory, snapshotPath)) {
      throw new SpeechEngineError(
        'configuration',
        'Qwen output directory and model snapshot must not overlap',
      )
    }
    return new QwenTtsSpeechEngine(
      { ...config, repositoryRoot, outputDirectory, snapshotPath },
      production,
    )
  }

  async renderBatch(
    segments: ReadonlyArray<SpeechSegmentRequest>,
    options: SpeechRenderOptions = {},
  ): Promise<SpeechBatchResult> {
    validateRequests(segments)
    if (options.signal?.aborted)
      throw new SpeechEngineError('cancelled', 'Qwen render batch was cancelled')
    if (segments.length === 0) {
      emit(options, { type: 'batch-started', total: 0, renderCount: 0, reuseCount: 0 })
      emit(options, { type: 'batch-completed', rendered: 0, reused: 0 })
      return { results: [], rendered: 0, reused: 0 }
    }

    let lease: GpuLease
    try {
      lease = await this.#gpuGate.acquire('qwen3-tts', options.signal)
    } catch (error) {
      if (options.signal?.aborted)
        throw new SpeechEngineError('cancelled', 'Qwen render batch was cancelled', {
          cause: error,
        })
      if (error instanceof SpeechEngineError) throw error
      throw new SpeechEngineError(
        'gpu-busy',
        'Cannot acquire the exclusive GPU lease for Qwen3-TTS',
        { cause: error },
      )
    }

    try {
      const plans = segments.map((request, index) =>
        createSegmentPlan(index + 1, request, this.#paths.outputDirectory, this.#production),
      )
      const reused = new Map<string, SpeechSegmentResult>()
      const stale: Array<SegmentPlan> = []
      for (const plan of plans) {
        if (options.signal?.aborted)
          throw new SpeechEngineError('cancelled', 'Qwen render batch was cancelled')
        const cached = await tryReuse(plan, this.#production)
        if (cached) reused.set(plan.request.segmentId, cached)
        else stale.push(plan)
      }
      emit(options, {
        type: 'batch-started',
        total: plans.length,
        renderCount: stale.length,
        reuseCount: reused.size,
      })
      let completed = 0
      for (const plan of plans) {
        if (!reused.has(plan.request.segmentId)) continue
        completed += 1
        emit(options, {
          type: 'segment-reused',
          segmentId: plan.request.segmentId,
          completed,
          total: plans.length,
        })
      }

      if (options.signal?.aborted)
        throw new SpeechEngineError('cancelled', 'Qwen render batch was cancelled')
      const rendered =
        stale.length === 0
          ? new Map<string, SpeechSegmentResult>()
          : await this.#runWorker(stale, options, completed, plans.length)
      const results = plans.map((plan) => {
        const result = reused.get(plan.request.segmentId) ?? rendered.get(plan.request.segmentId)
        if (!result)
          throw protocolError(
            `missing result for ${plan.request.segmentId}`,
            plan.request.segmentId,
          )
        return result
      })
      emit(options, { type: 'batch-completed', rendered: rendered.size, reused: reused.size })
      return { results, rendered: rendered.size, reused: reused.size }
    } finally {
      await lease.release()
    }
  }

  async #runWorker(
    plans: ReadonlyArray<SegmentPlan>,
    options: SpeechRenderOptions,
    completedBeforeRender: number,
    total: number,
  ): Promise<Map<string, SpeechSegmentResult>> {
    if (options.signal?.aborted)
      throw new SpeechEngineError('cancelled', 'Qwen render batch was cancelled')
    const child = spawn(this.#paths.pythonExecutable, [this.#paths.workerScriptPath], {
      cwd: this.#paths.repositoryRoot,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...this.#environment,
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
        HF_DATASETS_OFFLINE: '1',
        PYTHONUNBUFFERED: '1',
      },
      windowsHide: true,
    })
    emit(options, { type: 'process-started', renderCount: plans.length })

    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit, reject) => {
        child.once('error', reject)
        child.once('close', (code, signal) => resolveExit({ code, signal }))
      },
    )
    child.stdin.on('error', () => undefined)

    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_BYTES)
    })

    let killedForCancellation = false
    let forceKill: NodeJS.Timeout | undefined
    const terminate = (cancelled: boolean): void => {
      if (child.exitCode !== null || child.signalCode !== null) return
      if (cancelled) killedForCancellation = true
      try {
        if (process.platform === 'win32' || child.pid === undefined) child.kill('SIGTERM')
        else process.kill(-child.pid, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
      forceKill = setTimeout(() => {
        try {
          if (process.platform === 'win32' || child.pid === undefined) child.kill('SIGKILL')
          else process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }, this.#cancellationGraceMs)
      forceKill.unref()
    }
    const cancel = (): void => terminate(true)
    options.signal?.addEventListener('abort', cancel, { once: true })

    const input = {
      protocolVersion: 1,
      command: 'render-batch',
      productionConfigPath: this.#paths.productionConfigPath,
      productionConfigSha256: this.#production.sha256,
      modelLockPath: this.#paths.modelLockPath,
      runtimeManifestPath: this.#paths.runtimeManifestPath,
      uvLockPath: this.#paths.uvLockPath,
      snapshotPath: this.#paths.snapshotPath,
      outputDirectory: this.#paths.outputDirectory,
      segments: plans.map((plan) => ({
        sequence: plan.sequence,
        segmentId: plan.request.segmentId,
        text: plan.request.text,
        voiceProfileId: plan.profile.id,
        seed: plan.seed,
        renderIdentitySha256: plan.identitySha256,
      })),
    }
    child.stdin.end(`${JSON.stringify(input)}\n`)

    const expected = new Map(plans.map((plan) => [plan.request.segmentId, plan]))
    const rendered = new Map<string, SpeechSegmentResult>()
    let phase: 'runtime' | 'loading' | 'loaded' | 'cleanup' | 'complete' = 'runtime'
    let activeSegment: SegmentPlan | undefined
    let workerFailure: string | undefined
    let protocolFailure: unknown
    let completed = completedBeforeRender

    try {
      const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY })
      for await (const line of lines) {
        if (Buffer.byteLength(line) > MAX_PROTOCOL_LINE_BYTES)
          throw protocolError('event line is too large')
        let event: WorkerEvent
        try {
          event = JSON.parse(line) as WorkerEvent
        } catch {
          throw protocolError(`malformed JSON event: ${line.slice(0, 160)}`)
        }
        if (event.protocolVersion !== 1 || typeof event.type !== 'string')
          throw protocolError('invalid event envelope')
        if (event.type === 'runtime-validated' && phase === 'runtime') {
          emit(options, { type: 'runtime-validated' })
          phase = 'loading'
        } else if (event.type === 'model-loading' && phase === 'loading') {
          emit(options, { type: 'model-loading' })
        } else if (event.type === 'model-loaded' && phase === 'loading') {
          emit(options, { type: 'model-loaded' })
          phase = 'loaded'
        } else if (
          event.type === 'segment-started' &&
          phase === 'loaded' &&
          activeSegment === undefined
        ) {
          const plan = event.segmentId === undefined ? undefined : expected.get(event.segmentId)
          if (!plan || plan.sequence !== event.sequence || rendered.has(plan.request.segmentId)) {
            throw protocolError('unexpected segment-started identity', event.segmentId)
          }
          const expectedNext = plans[rendered.size]
          if (expectedNext !== plan)
            throw protocolError('worker changed ordered batch execution', event.segmentId)
          activeSegment = plan
          emit(options, {
            type: 'segment-started',
            segmentId: plan.request.segmentId,
            sequence: plan.sequence,
          })
        } else if (
          event.type === 'segment-rendered' &&
          phase === 'loaded' &&
          activeSegment !== undefined
        ) {
          if (
            event.segmentId !== activeSegment.request.segmentId ||
            event.sequence !== activeSegment.sequence ||
            typeof event.sha256 !== 'string' ||
            !SHA256.test(event.sha256)
          ) {
            throw protocolError('segment-rendered identity or hash mismatch', event.segmentId)
          }
          const result = await recordRendered(activeSegment, this.#production, event.sha256)
          rendered.set(activeSegment.request.segmentId, result)
          completed += 1
          emit(options, {
            type: 'segment-rendered',
            segmentId: activeSegment.request.segmentId,
            completed,
            total,
          })
          activeSegment = undefined
        } else if (
          event.type === 'gpu-cleanup-complete' &&
          phase === 'loaded' &&
          activeSegment === undefined &&
          rendered.size === plans.length
        ) {
          emit(options, { type: 'gpu-cleanup-complete' })
          phase = 'cleanup'
        } else if (event.type === 'batch-complete' && phase === 'cleanup') {
          phase = 'complete'
        } else if (event.type === 'fatal' && typeof event.message === 'string') {
          workerFailure = `${event.stage ?? 'worker'}: ${event.message}`
        } else {
          throw protocolError(`unexpected ${event.type} event in ${phase} phase`, event.segmentId)
        }
      }
    } catch (error) {
      protocolFailure = error
      terminate(false)
    }

    const exit = await exitPromise.catch((error: unknown) => {
      throw new SpeechEngineError(
        'process-failed',
        'Could not start the pinned Qwen Python runtime',
        { cause: error },
      )
    })
    if (forceKill) clearTimeout(forceKill)
    options.signal?.removeEventListener('abort', cancel)

    if (options.signal?.aborted || killedForCancellation) {
      throw new SpeechEngineError('cancelled', 'Qwen render batch was cancelled')
    }
    if (protocolFailure) {
      if (protocolFailure instanceof SpeechEngineError) throw protocolFailure
      throw protocolError('failed while validating worker output')
    }
    if (exit.code !== 0 || phase !== 'complete' || workerFailure !== undefined) {
      const details = workerFailure ?? stderr.trim().slice(-2_000) ?? `exit ${exit.code}`
      throw new SpeechEngineError(
        'process-failed',
        `Qwen batch worker failed${activeSegment ? ` at ${activeSegment.request.segmentId}` : ''}: ${details || `exit ${exit.code ?? exit.signal}`}`,
        { ...(activeSegment === undefined ? {} : { segmentId: activeSegment.request.segmentId }) },
      )
    }
    return rendered
  }
}
