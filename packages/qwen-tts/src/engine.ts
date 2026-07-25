import { lstat, mkdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { LoadedProductionConfig } from './config.js'
import { loadProductionConfig } from './config.js'
import type { SegmentPlan } from './manifest.js'
import { canonicalJson, createSegmentPlan, sha256, tryReuse } from './manifest.js'
import type { QwenWorkerRuntimeIdentity } from './runtime-identity.js'
import { loadWorkerRuntimeIdentity } from './runtime-identity.js'
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
import { QwenWorkerSession } from './worker-session.js'

const SEGMENT_ID = /^(?:ch[0-9]+-[0-9]+|book-[0-9a-f]{24}-ch[0-9]{4}-p[0-9]{6}-s[0-9]{4})$/
const SHA256 = /^[0-9a-f]{64}$/
const APPROVAL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/
const FORBIDDEN_PYTHON_ENVIRONMENT = new Set(['PYTHONHOME', 'PYTHONPATH', 'PYTHONSTARTUP'])

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
  /** False for immutable smoke roots. Normal production invalidation atomically replaces stale WAVs. */
  readonly allowOverwriteExisting?: boolean
}

interface NormalizedPaths {
  readonly pythonExecutable: string
  readonly workerScriptPath: string
  readonly productionConfigPath: string
  readonly modelLockPath: string
  readonly runtimeManifestPath: string
  readonly uvLockPath: string
  readonly snapshotPath: string
  readonly outputDirectory: string
  readonly repositoryRoot: string
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function regularFile(path: string, label: string): Promise<void> {
  try {
    const info = await stat(path)
    if (!info.isFile()) throw new Error('not a regular file')
  } catch (error) {
    throw new SpeechEngineError('configuration', `${label} is unavailable: ${path}`, {
      cause: error,
    })
  }
}

function validateRequest(segment: SpeechSegmentRequest): void {
  if (!SEGMENT_ID.test(segment.segmentId)) {
    throw new SpeechEngineError(
      'configuration',
      `Unsafe or noncanonical segment ID: ${segment.segmentId}`,
      { segmentId: segment.segmentId },
    )
  }
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
  if (
    segment.applicationInputIdentity !== undefined &&
    !SHA256.test(segment.applicationInputIdentity)
  ) {
    throw new SpeechEngineError(
      'configuration',
      `Segment ${segment.segmentId} has invalid application input identity`,
      { segmentId: segment.segmentId },
    )
  }
  const fallback = segment.voiceProfileId === undefined
  if (fallback) {
    if (
      segment.fallbackApproval === undefined ||
      !APPROVAL_ID.test(segment.fallbackApproval.approvalId) ||
      !SHA256.test(segment.fallbackApproval.approvalSha256)
    ) {
      throw new SpeechEngineError(
        'configuration',
        `Fallback segment ${segment.segmentId} requires an explicit persisted approval identity and hash`,
        { segmentId: segment.segmentId },
      )
    }
  } else if (segment.fallbackApproval !== undefined) {
    throw new SpeechEngineError(
      'configuration',
      `Non-fallback segment ${segment.segmentId} cannot carry fallback approval`,
      { segmentId: segment.segmentId },
    )
  }
  if (segment.delivery !== undefined) {
    const { emotion, pace, volume, pauseAfterMs } = segment.delivery
    if (
      emotion.length === 0 ||
      emotion.length > 64 ||
      [...emotion].some((character) => {
        const codePoint = character.codePointAt(0)
        return codePoint !== undefined && (codePoint < 32 || codePoint === 127)
      }) ||
      !['slow', 'normal', 'fast'].includes(pace) ||
      !['soft', 'normal', 'loud'].includes(volume) ||
      !Number.isSafeInteger(pauseAfterMs) ||
      pauseAfterMs < 0 ||
      pauseAfterMs > 10_000
    ) {
      throw new SpeechEngineError(
        'configuration',
        `Segment ${segment.segmentId} has invalid delivery`,
        {
          segmentId: segment.segmentId,
        },
      )
    }
  }
}

function validateRequests(segments: ReadonlyArray<SpeechSegmentRequest>): void {
  const ids = new Set<string>()
  for (const segment of segments) {
    validateRequest(segment)
    if (ids.has(segment.segmentId)) {
      throw new SpeechEngineError('configuration', `Duplicate segment ID: ${segment.segmentId}`, {
        segmentId: segment.segmentId,
      })
    }
    ids.add(segment.segmentId)
  }
}

async function progress(options: SpeechRenderOptions, event: SpeechProgressEvent): Promise<void> {
  await options.onProgress?.(event)
}

export interface QwenManagedBatch {
  render(request: SpeechSegmentRequest): Promise<SpeechSegmentResult>
  end(): Promise<void>
}

export class QwenTtsSpeechEngine implements SpeechEngine {
  readonly identity: string
  readonly #paths: NormalizedPaths
  readonly #gpuGate: ExclusiveGpuGate
  readonly #environment: Readonly<Record<string, string>>
  readonly #cancellationGraceMs: number
  readonly #allowOverwriteExisting: boolean
  readonly #production: LoadedProductionConfig
  readonly #runtimeIdentity: QwenWorkerRuntimeIdentity

  private constructor(
    config: QwenTtsEngineConfig,
    production: LoadedProductionConfig,
    runtimeIdentity: QwenWorkerRuntimeIdentity,
  ) {
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
    this.#allowOverwriteExisting = config.allowOverwriteExisting ?? true
    this.#production = production
    this.#runtimeIdentity = runtimeIdentity
    this.identity = sha256(
      canonicalJson({
        adapter: production.value.adapter,
        model: production.value.model,
        runtime: production.value.runtime,
        workerRuntime: runtimeIdentity,
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
    for (const key of Object.keys(config.processEnvironment ?? {})) {
      if (FORBIDDEN_PYTHON_ENVIRONMENT.has(key.toUpperCase())) {
        throw new SpeechEngineError(
          'configuration',
          `${key} cannot be supplied to the pinned Python runtime`,
        )
      }
    }
    const paths: NormalizedPaths = {
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
    const filePaths = [
      [paths.pythonExecutable, 'Pinned Python executable'],
      [paths.workerScriptPath, 'Qwen batch worker'],
      [paths.productionConfigPath, 'Qwen production configuration'],
      [paths.modelLockPath, 'Qwen model lock'],
      [paths.runtimeManifestPath, 'Qwen runtime manifest'],
      [paths.uvLockPath, 'Qwen uv lock'],
    ] as const
    await Promise.all(filePaths.map(([path, label]) => regularFile(path, label)))
    const production = await loadProductionConfig(paths.productionConfigPath)
    const runtimeIdentity = await loadWorkerRuntimeIdentity(paths, production)
    await mkdir(paths.outputDirectory, { recursive: true, mode: 0o700 })
    const [repositoryRoot, outputDirectory, snapshotPath] = await Promise.all([
      realpath(paths.repositoryRoot),
      realpath(paths.outputDirectory),
      realpath(paths.snapshotPath),
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
      runtimeIdentity,
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
      await progress(options, { type: 'batch-started', total: 0, renderCount: 0, reuseCount: 0 })
      await progress(options, { type: 'batch-completed', rendered: 0, reused: 0 })
      return { results: [], rendered: 0, reused: 0 }
    }

    const plans = segments.map((request, index) =>
      createSegmentPlan(index + 1, request, this.#paths.outputDirectory, this.#production),
    )
    const reused = new Map<string, SpeechSegmentResult>()
    const stale: SegmentPlan[] = []
    for (const plan of plans) {
      if (options.signal?.aborted)
        throw new SpeechEngineError('cancelled', 'Qwen render batch was cancelled')
      const cached = await tryReuse(plan, this.#production)
      if (cached) reused.set(plan.request.segmentId, cached)
      else stale.push(plan)
    }
    if (!this.#allowOverwriteExisting) {
      for (const plan of stale) {
        if ((await pathExists(plan.wavPath)) || (await pathExists(plan.manifestPath))) {
          throw new SpeechEngineError(
            'configuration',
            `Immutable output already exists for ${plan.request.segmentId}`,
            { segmentId: plan.request.segmentId },
          )
        }
      }
    }
    await progress(options, {
      type: 'batch-started',
      total: plans.length,
      renderCount: stale.length,
      reuseCount: reused.size,
    })
    let completed = 0
    for (const plan of plans) {
      if (!reused.has(plan.request.segmentId)) continue
      completed += 1
      await progress(options, {
        type: 'segment-reused',
        segmentId: plan.request.segmentId,
        completed,
        total: plans.length,
      })
    }

    const rendered = new Map<string, SpeechSegmentResult>()
    if (stale.length > 0) {
      const lease = await this.#acquireLease(options.signal)
      let session: QwenWorkerSession | undefined
      try {
        session = await QwenWorkerSession.start(this.#workerConfig(), options, stale.length)
        for (const plan of stale) {
          const result = await session.render(plan)
          rendered.set(plan.request.segmentId, result)
          completed += 1
          await progress(options, {
            type: 'segment-rendered',
            segmentId: plan.request.segmentId,
            completed,
            total: plans.length,
          })
        }
        await session.finish()
      } catch (error) {
        if (session !== undefined) await session.abort()
        throw error
      } finally {
        // Worker exit is always awaited before the cross-process GPU lease is released.
        await lease.release()
      }
    }

    const results = plans.map((plan) => {
      const result = reused.get(plan.request.segmentId) ?? rendered.get(plan.request.segmentId)
      if (!result)
        throw new SpeechEngineError('protocol', `Missing result for ${plan.request.segmentId}`)
      return result
    })
    await progress(options, {
      type: 'batch-completed',
      rendered: rendered.size,
      reused: reused.size,
    })
    return { results, rendered: rendered.size, reused: reused.size }
  }

  selectedVoiceProfile(voice: {
    readonly syntheticSpeaker: string
    readonly instruction: string
    readonly seed: number
  }): SpeechSegmentResult['voiceProfileId'] {
    const match = this.#production.value.voiceProfiles.find(
      (profile) =>
        profile.speaker === voice.syntheticSpeaker &&
        profile.instruction === voice.instruction &&
        profile.seedSalt === voice.seed,
    )
    if (match === undefined) {
      throw new SpeechEngineError(
        'configuration',
        'Application voice does not match an approved pinned Qwen profile',
      )
    }
    return match.id
  }

  /** Starts one loaded Python process for the application begin/render/end port. */
  async beginManagedBatch(options: SpeechRenderOptions = {}): Promise<QwenManagedBatch> {
    const lease = await this.#acquireLease(options.signal)
    let session: QwenWorkerSession | undefined
    try {
      session = await QwenWorkerSession.start(this.#workerConfig(), options, 0)
      const activeSession = session
      let sequence = 0
      let ended = false
      const end = async (): Promise<void> => {
        if (ended) return
        ended = true
        try {
          await activeSession.finish()
        } finally {
          await lease.release()
        }
      }
      return {
        render: async (request) => {
          if (ended) throw new SpeechEngineError('configuration', 'Qwen batch has already ended')
          validateRequest(request)
          sequence += 1
          const plan = createSegmentPlan(
            sequence,
            request,
            this.#paths.outputDirectory,
            this.#production,
          )
          const cached = await tryReuse(plan, this.#production)
          try {
            if (cached) {
              await progress(options, {
                type: 'segment-reused',
                segmentId: request.segmentId,
                completed: sequence,
                total: sequence,
              })
              return cached
            }
            const rendered = await activeSession.render(plan)
            await progress(options, {
              type: 'segment-rendered',
              segmentId: request.segmentId,
              completed: sequence,
              total: sequence,
            })
            return rendered
          } catch (error) {
            ended = true
            await activeSession.abort()
            await lease.release()
            throw error
          }
        },
        end,
      }
    } catch (error) {
      if (session !== undefined) await session.abort()
      await lease.release()
      throw error
    }
  }

  async #acquireLease(signal?: AbortSignal): Promise<GpuLease> {
    try {
      return await this.#gpuGate.acquire('qwen3-tts', signal)
    } catch (error) {
      if (signal?.aborted)
        throw new SpeechEngineError('cancelled', 'Qwen render batch was cancelled', {
          cause: error,
        })
      if (error instanceof SpeechEngineError) throw error
      throw new SpeechEngineError(
        'gpu-busy',
        'Cannot acquire the shared cross-process GPU lease for Qwen3-TTS',
        {
          cause: error,
        },
      )
    }
  }

  #workerConfig() {
    return {
      ...this.#paths,
      environment: this.#environment,
      cancellationGraceMs: this.#cancellationGraceMs,
      allowOverwriteExisting: this.#allowOverwriteExisting,
      production: this.#production,
      runtimeIdentity: this.#runtimeIdentity,
    }
  }
}
