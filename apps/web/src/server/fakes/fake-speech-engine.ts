import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  CompletedSegmentAudio,
  SpeechEngine,
  SpeechRenderRequest,
} from '@light-novel-audiobook/application'
import type { FallbackReason } from '@light-novel-audiobook/domain'
import type { PinnedVoiceMaterial } from '../m1-voice-cast.js'
import type { LocalWorkspace } from '../workspace.js'
import { createPlaceholderWav } from './placeholder-wav.js'

const SHA256 = /^[0-9a-f]{64}$/
/** Same shape the real engine requires of a persisted approval identity. */
const APPROVAL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/

/** Same shape the merged Qwen adapter requires: one human decision bound to one segment. */
export interface FakeFallbackApproval {
  readonly segmentId: string
  readonly speakerId: string | null
  readonly fallbackReason: FallbackReason
  readonly approvalId: string
  readonly approvalSha256: string
}

export interface FakeSpeechEngineOptions {
  /** Test seam: lets a test hold a render open to observe mid-generation state. */
  readonly beforeRender?: ((segmentId: string) => Promise<void>) | undefined
  /** The cast's fallback profile. A fallback render must use exactly this profile. */
  readonly fallbackVoiceProfileId?: string | undefined
  /** Persisted human decisions authorizing fallback use, one per approved segment. */
  readonly fallbackApprovals?: readonly FakeFallbackApproval[] | undefined
  /**
   * What to do about a fallback segment with no approval record. `'reject'` is the default and
   * matches the merged Qwen adapter. `'auto-approve'` is an explicit M1 stand-in for the approval
   * workflow the UI does not have yet; it still mints a segment-specific, identity-bound record and
   * records it on `autoApprovedFallbacks` so nothing about it is silent.
   */
  readonly unreviewedFallbackPolicy?: 'reject' | 'auto-approve' | undefined
  /**
   * The approved profiles the real engine would match on. When supplied, a voice whose
   * `syntheticSpeaker`/`instruction`/`seed` does not resolve is refused exactly as
   * `QwenTtsSpeechEngine.selectedVoiceProfile()` refuses it — so a cast that drifts from the pinned
   * configuration fails here instead of surviving until the first GPU run.
   */
  readonly pinnedVoiceProfiles?: readonly PinnedVoiceMaterial[] | undefined
}

/**
 * FAKE speech engine. It writes tiny placeholder WAVs into the workspace, needs no GPU and no model,
 * and rejects everything `QwenApplicationSpeechEngine` rejects:
 *
 * - a second open batch, and a render outside a batch;
 * - overlapping renders (`render` must stay ordered and serial);
 * - a non-SHA-256 `inputIdentity`;
 * - a segment whose voice assignment does not match the voice handed to it, or whose fallback flag
 *   disagrees with the voice role;
 * - a fallback render that is not the configured fallback profile, or has no matching per-segment
 *   human approval.
 *
 * `endBatch()` is deliberately *not* terminal, because the real adapter clears its batch and accepts
 * a later `beginBatch()`. Issue #31's adapter replaces this.
 */
export class FakeSpeechEngine implements SpeechEngine {
  readonly identity = 'fake-speech-engine/2'
  private readonly workspace: LocalWorkspace
  private readonly beforeRender: ((segmentId: string) => Promise<void>) | undefined
  private readonly fallbackVoiceProfileId: string | undefined
  private readonly approvals: Map<string, FakeFallbackApproval>
  private readonly unreviewedFallbackPolicy: 'reject' | 'auto-approve'
  private readonly pinnedVoiceProfiles: readonly PinnedVoiceMaterial[] | undefined
  private readonly autoApproved: FakeFallbackApproval[] = []
  private batchOpen = false
  private rendering = false
  private renderedCount = 0

  constructor(workspace: LocalWorkspace, options: FakeSpeechEngineOptions = {}) {
    this.workspace = workspace
    this.beforeRender = options.beforeRender
    this.fallbackVoiceProfileId = options.fallbackVoiceProfileId
    this.unreviewedFallbackPolicy = options.unreviewedFallbackPolicy ?? 'reject'
    this.pinnedVoiceProfiles = options.pinnedVoiceProfiles
    this.approvals = new Map()
    // Validated on construction, like the real adapter: a duplicate or malformed approval is a
    // configuration error, not something to resolve by last-write-wins at render time.
    for (const approval of options.fallbackApprovals ?? []) {
      if (this.approvals.has(approval.segmentId)) {
        throw new Error(`Duplicate fallback approval for ${approval.segmentId}`)
      }
      if (!APPROVAL_ID.test(approval.approvalId) || !SHA256.test(approval.approvalSha256)) {
        throw new Error(
          `Fallback approval for ${approval.segmentId} needs a policy-safe ID and a lowercase SHA-256`,
        )
      }
      this.approvals.set(approval.segmentId, approval)
    }
  }

  get rendered(): number {
    return this.renderedCount
  }

  /** Every fallback this engine approved on the user's behalf, for tests and for review evidence. */
  get autoApprovedFallbacks(): readonly FakeFallbackApproval[] {
    return this.autoApproved
  }

  async beginBatch(): Promise<void> {
    if (this.batchOpen) throw new Error('Fake speech engine batch is already open')
    this.batchOpen = true
  }

  async render(request: SpeechRenderRequest): Promise<CompletedSegmentAudio> {
    if (!this.batchOpen) throw new Error('Fake speech engine rendered outside a batch')
    if (this.rendering) throw new Error('Fake speech engine renders must remain ordered and serial')
    if (!SHA256.test(request.inputIdentity)) {
      throw new Error('Fake speech engine render input identity must be a lowercase SHA-256')
    }

    const assignment = request.segment.voiceAssignment
    if (assignment === null || assignment.voiceProfileId !== request.voice.id) {
      throw new Error(`Fake speech engine voice assignment mismatch for ${request.segment.id}`)
    }
    if (assignment.usesFallback !== (request.voice.role === 'fallback')) {
      throw new Error(`Fake speech engine fallback role mismatch for ${request.segment.id}`)
    }
    this.requirePinnedVoice(request)
    if (assignment.usesFallback) {
      this.requireFallbackApproval(request, assignment.fallbackReason)
    }

    this.rendering = true
    try {
      await this.beforeRender?.(request.segment.id)

      const bytes = createPlaceholderWav(
        `${request.segment.id}:${request.voice.renderIdentity}`,
        request.segment.sourceText.length,
      )
      const wavPath = join(this.workspace.segmentsDir, `${request.segment.id}.wav`)
      await mkdir(this.workspace.segmentsDir, { recursive: true })
      await writeFile(wavPath, bytes)
      this.renderedCount += 1

      return {
        segmentId: request.segment.id,
        inputIdentity: request.inputIdentity,
        wavPath,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        byteLength: bytes.byteLength,
      }
    } finally {
      this.rendering = false
    }
  }

  async endBatch(): Promise<void> {
    this.batchOpen = false
  }

  /** Mirrors `QwenTtsSpeechEngine.selectedVoiceProfile()`: exact speaker, instruction and seed. */
  private requirePinnedVoice(request: SpeechRenderRequest): void {
    if (this.pinnedVoiceProfiles === undefined) return
    const resolved = this.pinnedVoiceProfiles.some(
      (pinned) =>
        pinned.syntheticSpeaker === request.voice.syntheticSpeaker &&
        pinned.instruction === request.voice.instruction &&
        pinned.seed === request.voice.seed,
    )
    if (!resolved) {
      throw new Error(
        `Application voice ${request.voice.id} does not match an approved pinned Qwen profile`,
      )
    }
  }

  private requireFallbackApproval(
    request: SpeechRenderRequest,
    fallbackReason: FallbackReason | null,
  ): void {
    const segmentId = request.segment.id
    if (
      this.fallbackVoiceProfileId !== undefined &&
      request.voice.id !== this.fallbackVoiceProfileId
    ) {
      throw new Error(
        `Fallback segment ${segmentId} renders ${request.voice.id} but the configured fallback is ${this.fallbackVoiceProfileId}`,
      )
    }
    if (fallbackReason === null) {
      throw new Error(`Fallback segment ${segmentId} has no fallback reason`)
    }

    const approval = this.approvals.get(segmentId)
    if (approval === undefined) {
      if (this.unreviewedFallbackPolicy === 'reject') {
        throw new Error(`Fallback segment ${segmentId} has no explicit human approval identity`)
      }
      this.approvals.set(segmentId, this.mintUnreviewedApproval(request, fallbackReason))
      return
    }
    if (
      approval.speakerId !== request.segment.speakerId ||
      approval.fallbackReason !== fallbackReason
    ) {
      throw new Error(
        `Fallback approval for ${segmentId} does not match its unresolved speaker decision`,
      )
    }
  }

  /** Segment-specific and content-addressed, so it can never authorize another speaker's line. */
  private mintUnreviewedApproval(
    request: SpeechRenderRequest,
    fallbackReason: FallbackReason,
  ): FakeFallbackApproval {
    const approval: FakeFallbackApproval = {
      segmentId: request.segment.id,
      speakerId: request.segment.speakerId,
      fallbackReason,
      approvalId: `unreviewed:${request.segment.id}`,
      approvalSha256: createHash('sha256')
        .update(
          JSON.stringify([
            'unreviewed-fallback',
            request.segment.id,
            request.segment.speakerId,
            fallbackReason,
            request.voice.id,
          ]),
        )
        .digest('hex'),
    }
    this.autoApproved.push(approval)
    return approval
  }
}
