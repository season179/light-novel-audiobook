import type {
  SpeechEngine as ApplicationSpeechEngine,
  CompletedSegmentAudio,
  SpeechRenderRequest,
} from '@light-novel-audiobook/application'
import type { FallbackReason } from '@light-novel-audiobook/domain'
import type { QwenManagedBatch, QwenTtsSpeechEngine } from './engine.js'
import { canonicalJson, sha256 } from './manifest.js'
import type { FallbackApproval, SpeechRenderOptions } from './types.js'
import { SpeechEngineError } from './types.js'

const SHA256 = /^[0-9a-f]{64}$/

/** One persisted human decision, bound to the exact segment whose speaker was unresolved. */
export interface FallbackApprovalRecord extends FallbackApproval {
  readonly segmentId: string
  readonly speakerId: string | null
  readonly fallbackReason: FallbackReason
}

export interface QwenApplicationSpeechEngineOptions extends SpeechRenderOptions {
  /**
   * Persisted human decisions authorizing fallback use, one per approved segment. A single
   * batch-wide approval is deliberately not accepted: PLAN stage 7 requires the human to approve
   * *an unresolved speaker*, so approving speaker A must never render speaker B's dialogue.
   */
  readonly fallbackApprovals?: ReadonlyArray<FallbackApprovalRecord>
}

/** Implements the finalized issue #29 begin/render/end SpeechEngine port. */
export class QwenApplicationSpeechEngine implements ApplicationSpeechEngine {
  readonly identity: string
  readonly #engine: QwenTtsSpeechEngine
  readonly #options: QwenApplicationSpeechEngineOptions
  readonly #approvals: ReadonlyMap<string, FallbackApprovalRecord>
  #batch: QwenManagedBatch | undefined
  #rendering = false

  constructor(engine: QwenTtsSpeechEngine, options: QwenApplicationSpeechEngineOptions = {}) {
    this.#engine = engine
    this.#options = options
    const approvals = new Map<string, FallbackApprovalRecord>()
    for (const record of options.fallbackApprovals ?? []) {
      if (approvals.has(record.segmentId)) {
        throw new SpeechEngineError(
          'configuration',
          `Duplicate fallback approval for ${record.segmentId}`,
          { segmentId: record.segmentId },
        )
      }
      approvals.set(record.segmentId, record)
    }
    this.#approvals = approvals
    // The approval catalog is deliberately NOT hashed here. Approvals arrive incrementally as the
    // reviewer works through chapters, and issue #29 folds this identity into every segment's
    // inputIdentity and into the job command identity, so a growing catalog would re-render the
    // whole book and stale the running job on each approval click. Each approval is already bound
    // at the right granularity, into that segment's RenderIdentity.voice.fallbackApproval, so a
    // changed decision invalidates its own segment and nothing else.
    this.identity = sha256(
      canonicalJson({
        bridge: { id: 'qwen-issue-29-speech-engine', version: 2 },
        engine: engine.identity,
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
    const approval = usesFallback
      ? this.#approveFallback(request, assignment.fallbackReason, selectedProfileId)
      : undefined

    this.#rendering = true
    try {
      const result = await this.#batch.render({
        segmentId: request.segment.id,
        text: request.segment.sourceText,
        // A fallback render always uses the configured fallback profile, which #approveFallback
        // has already proven is the very profile the human approved for this speaker.
        ...(approval === undefined
          ? { voiceProfileId: selectedProfileId }
          : { fallbackApproval: approval }),
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

  /**
   * Resolves the human decision for one fallback segment. The cast's approved voice must be the
   * configured fallback profile: the adapter renders `fallbackVoiceProfileId`, so accepting any
   * other approved profile here would silently voice the segment with a speaker nobody approved.
   */
  #approveFallback(
    request: SpeechRenderRequest,
    fallbackReason: FallbackReason | null,
    selectedProfileId: string,
  ): FallbackApproval {
    const segmentId = request.segment.id
    if (selectedProfileId !== this.#engine.fallbackVoiceProfileId) {
      throw new SpeechEngineError(
        'configuration',
        `Fallback segment ${segmentId} approves ${selectedProfileId} but the adapter renders the configured fallback ${this.#engine.fallbackVoiceProfileId}`,
        { segmentId },
      )
    }
    const record = this.#approvals.get(segmentId)
    if (record === undefined) {
      throw new SpeechEngineError(
        'configuration',
        `Fallback segment ${segmentId} has no explicit human approval identity`,
        { segmentId },
      )
    }
    if (
      record.speakerId !== request.segment.speakerId ||
      record.fallbackReason !== fallbackReason
    ) {
      throw new SpeechEngineError(
        'configuration',
        `Fallback approval for ${segmentId} does not match its unresolved speaker decision`,
        { segmentId },
      )
    }
    return { approvalId: record.approvalId, approvalSha256: record.approvalSha256 }
  }

  async endBatch(): Promise<void> {
    const batch = this.#batch
    if (batch === undefined) return
    this.#batch = undefined
    await batch.end()
  }
}
