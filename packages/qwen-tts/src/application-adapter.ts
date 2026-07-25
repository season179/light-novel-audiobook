import type {
  SpeechEngine as ApplicationSpeechEngine,
  CompletedSegmentAudio,
  SpeechRenderRequest,
} from '@light-novel-audiobook/application'
import type { QwenManagedBatch, QwenTtsSpeechEngine } from './engine.js'
import { canonicalJson, sha256 } from './manifest.js'
import type { FallbackApproval, SpeechRenderOptions } from './types.js'
import { SpeechEngineError } from './types.js'

const SHA256 = /^[0-9a-f]{64}$/

export interface QwenApplicationSpeechEngineOptions extends SpeechRenderOptions {
  /** Persisted human decision authorizing unresolved-speaker fallback use. */
  readonly fallbackApproval?: FallbackApproval
}

/** Implements the finalized issue #29 begin/render/end SpeechEngine port. */
export class QwenApplicationSpeechEngine implements ApplicationSpeechEngine {
  readonly identity: string
  readonly #engine: QwenTtsSpeechEngine
  readonly #options: QwenApplicationSpeechEngineOptions
  #batch: QwenManagedBatch | undefined
  #rendering = false

  constructor(engine: QwenTtsSpeechEngine, options: QwenApplicationSpeechEngineOptions = {}) {
    this.#engine = engine
    this.#options = options
    this.identity = sha256(
      canonicalJson({
        bridge: { id: 'qwen-issue-29-speech-engine', version: 1 },
        engine: engine.identity,
        fallbackApproval: options.fallbackApproval ?? null,
      }),
    )
  }

  async beginBatch(): Promise<void> {
    if (this.#batch !== undefined) {
      throw new SpeechEngineError('configuration', 'Qwen application batch is already active')
    }
    this.#batch = await this.#engine.beginManagedBatch(this.#options)
  }

  async render(request: SpeechRenderRequest): Promise<CompletedSegmentAudio> {
    if (this.#batch === undefined) {
      throw new SpeechEngineError('configuration', 'Qwen application batch has not started')
    }
    if (this.#rendering) {
      throw new SpeechEngineError(
        'configuration',
        'Qwen application renders must remain ordered and serial',
      )
    }
    if (!SHA256.test(request.inputIdentity)) {
      throw new SpeechEngineError(
        'configuration',
        'Application render input identity must be a SHA-256',
      )
    }
    const assignment = request.segment.voiceAssignment
    if (assignment === null || assignment.voiceProfileId !== request.voice.id) {
      throw new SpeechEngineError(
        'configuration',
        `Application voice assignment mismatch for ${request.segment.id}`,
        { segmentId: request.segment.id },
      )
    }
    const usesFallback = assignment.usesFallback
    if (usesFallback !== (request.voice.role === 'fallback')) {
      throw new SpeechEngineError(
        'configuration',
        `Fallback role/assignment mismatch for ${request.segment.id}`,
        { segmentId: request.segment.id },
      )
    }
    const selectedProfileId = this.#engine.selectedVoiceProfile(request.voice)
    if (usesFallback && this.#options.fallbackApproval === undefined) {
      throw new SpeechEngineError(
        'configuration',
        `Fallback segment ${request.segment.id} has no explicit human approval identity`,
        { segmentId: request.segment.id },
      )
    }

    this.#rendering = true
    try {
      const result = await this.#batch.render({
        segmentId: request.segment.id,
        text: request.segment.sourceText,
        ...(usesFallback ? {} : { voiceProfileId: selectedProfileId }),
        ...(usesFallback ? { fallbackApproval: this.#options.fallbackApproval } : {}),
        applicationInputIdentity: request.inputIdentity,
        delivery: request.segment.delivery,
      })
      if (result.segmentId !== request.segment.id) {
        throw new SpeechEngineError('protocol', 'Qwen application segment identity changed')
      }
      return Object.freeze({
        segmentId: result.segmentId,
        inputIdentity: request.inputIdentity,
        wavPath: result.wavPath,
        sha256: result.audio.sha256,
        byteLength: result.audio.bytes,
      })
    } finally {
      this.#rendering = false
    }
  }

  async endBatch(): Promise<void> {
    const batch = this.#batch
    if (batch === undefined) return
    this.#batch = undefined
    await batch.end()
  }
}
