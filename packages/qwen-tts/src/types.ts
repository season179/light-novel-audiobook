export const SELECTED_VOICE_PROFILE_IDS = [
  'aiden-calm-narrator',
  'ryan-energetic-baseline',
  'ryan-low-weary',
  // Approved by the issue-92 listening decision: seven more of the model's built-in speakers, each at
  // the auditioned instruction. Character material only — the narrator and fallback roles are unchanged.
  'dylan-neutral-read',
  'eric-neutral-read',
  'ono-anna-neutral-read',
  'serena-neutral-read',
  'sohee-neutral-read',
  'uncle-fu-neutral-read',
  'vivian-neutral-read',
] as const

export type SelectedVoiceProfileId = (typeof SELECTED_VOICE_PROFILE_IDS)[number]

/**
 * Every speaker a human has approved for English, exactly as the pinned config spells it. The two
 * capitalised entries predate the issue-92 audition and are left as written: their approved audio was
 * rendered with those strings, and the model accepts either case.
 */
export const APPROVED_SPEAKERS = [
  'Aiden',
  'Ryan',
  'dylan',
  'eric',
  'ono_anna',
  'serena',
  'sohee',
  'uncle_fu',
  'vivian',
] as const

export type ApprovedSpeaker = (typeof APPROVED_SPEAKERS)[number]

export interface SpeechDeliveryDirection {
  readonly emotion: string
  readonly pace: 'slow' | 'normal' | 'fast'
  readonly volume: 'soft' | 'normal' | 'loud'
  readonly pauseAfterMs: number
}

export interface FallbackApproval {
  readonly approvalId: string
  readonly approvalSha256: string
}

export interface SpeechSegmentRequest {
  /** Stable ID from the approved script. It also determines the canonical WAV filename. */
  readonly segmentId: string
  /** Exact approved render text. This adapter never normalizes or rewrites it. */
  readonly text: string
  /** Omit only with fallbackApproval from the persisted human review decision. */
  readonly voiceProfileId?: SelectedVoiceProfileId
  readonly fallbackApproval?: FallbackApproval
  /** Finalized issue #29 content address, persisted in the render manifest when supplied. */
  readonly applicationInputIdentity?: string
  readonly delivery?: SpeechDeliveryDirection
}

export interface SpeechRenderOptions {
  readonly signal?: AbortSignal
  readonly onProgress?: (event: SpeechProgressEvent) => void | Promise<void>
}

export type SpeechProgressEvent =
  | {
      readonly type: 'batch-started'
      readonly total: number
      readonly renderCount: number
      readonly reuseCount: number
    }
  | {
      readonly type: 'segment-reused'
      readonly segmentId: string
      readonly completed: number
      readonly total: number
    }
  | { readonly type: 'process-started'; readonly renderCount: number }
  | { readonly type: 'runtime-validated' }
  | { readonly type: 'model-loading' }
  | { readonly type: 'model-loaded' }
  | { readonly type: 'segment-started'; readonly segmentId: string; readonly sequence: number }
  | {
      readonly type: 'segment-rendered'
      readonly segmentId: string
      readonly completed: number
      readonly total: number
    }
  | { readonly type: 'gpu-cleanup-complete' }
  /**
   * The batch finished but the cross-process GPU lease could not be released cleanly. Never fatal
   * — the kernel flock is freed by the holder's death — but a lease that repeatedly needs SIGKILL
   * is worth surfacing.
   */
  | { readonly type: 'lease-release-failed'; readonly message: string }
  | { readonly type: 'batch-completed'; readonly rendered: number; readonly reused: number }

export interface SpeechAudioIdentity {
  readonly sha256: string
  readonly bytes: number
  readonly sampleRateHz: number
  readonly channels: number
  readonly bitsPerSample: number
  readonly frames: number
  readonly durationSeconds: number
}

export interface SpeechSegmentResult {
  readonly segmentId: string
  readonly status: 'rendered' | 'reused'
  readonly voiceProfileId: SelectedVoiceProfileId
  readonly usedFallback: boolean
  readonly wavPath: string
  readonly manifestPath: string
  readonly renderIdentitySha256: string
  readonly audio: SpeechAudioIdentity
}

export interface SpeechBatchResult {
  readonly results: ReadonlyArray<SpeechSegmentResult>
  readonly rendered: number
  readonly reused: number
  /**
   * Set when every segment completed but the cross-process GPU lease could not be released
   * cleanly. The batch is still valid; the kernel flock is freed by the holder's death.
   */
  readonly leaseReleaseError?: Error
}

/**
 * Temporary M1 port. Issue #29 can replace this shape at the composition root without changing
 * the Qwen process protocol; see docs/integration/issue-31-qwen-tts.md.
 */
export interface SpeechEngine {
  /** Model/runtime/global generation identity; segment text and voice stay segment-scoped. */
  readonly identity: string
  renderBatch(
    segments: ReadonlyArray<SpeechSegmentRequest>,
    options?: SpeechRenderOptions,
  ): Promise<SpeechBatchResult>
}

export type SpeechEngineErrorCode =
  | 'cancelled'
  | 'configuration'
  | 'gpu-busy'
  | 'process-failed'
  | 'protocol'
  | 'audio-validation'

export class SpeechEngineError extends Error {
  override readonly name = 'SpeechEngineError'
  readonly code: SpeechEngineErrorCode
  readonly segmentId: string | undefined

  constructor(
    code: SpeechEngineErrorCode,
    message: string,
    options: { cause?: unknown; segmentId?: string } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
    this.segmentId = options.segmentId
  }
}

export type {
  ExclusiveGpuLeaseCoordinator as ExclusiveGpuGate,
  GpuLease,
  GpuOwner,
} from '@light-novel-audiobook/gpu-lease'
