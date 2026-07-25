export const DIRECTOR_SEGMENT_KINDS = [
  'narration',
  'dialogue',
  'thought',
  'message',
  'sound_cue',
] as const

export type DirectorSegmentKind = (typeof DIRECTOR_SEGMENT_KINDS)[number]

export interface DirectorSourcePassage {
  readonly id: string
  readonly text: string
}

export interface DirectorSpeaker {
  readonly id: string
  readonly aliases: readonly string[]
}

export interface DirectionRequest {
  /** Stable application run/job ID used by persisted progress records. */
  readonly requestId: string
  readonly chapterId: string
  readonly passages: readonly DirectorSourcePassage[]
  readonly speakers: readonly DirectorSpeaker[]
  readonly narratorSpeakerId: string
  readonly fallbackSpeakerId: string
  readonly storyContext?: string
}

export type DeliveryEmotion =
  | 'neutral'
  | 'calm'
  | 'warm'
  | 'uneasy'
  | 'sad'
  | 'firm'
  | 'tense'
  | 'weary'

export interface DeliveryDirection {
  readonly emotion: DeliveryEmotion
  readonly pace: 'slow' | 'normal' | 'fast'
  readonly volume: 'soft' | 'normal' | 'loud'
  readonly pauseAfterMs: number
}

export interface DirectedSegment {
  readonly sourcePassageId: string
  readonly sourceText: string
  readonly kind: DirectorSegmentKind
  readonly speakerId: string
  readonly confidence: number
  readonly delivery: DeliveryDirection
  readonly unresolvedSpeaker: boolean
  readonly speakerReason: string | null
}

export interface DirectorWarning {
  readonly code: 'unresolved_speaker'
  readonly sourcePassageId: string
  readonly fallbackSpeakerId: string
  readonly confidence: number
  readonly message: string
  readonly reviewRequired: true
}

export interface DirectorModelIdentity {
  readonly adapter: 'tanstack-ai-openai-compatible'
  readonly profileId: string
  readonly modelId: string
  readonly modelRevision: string
  readonly modelSha256: string
  readonly promptVersion: string
  readonly schemaVersion: string
}

export interface DirectorParameters {
  readonly seed: 42
  readonly temperature: 0
  readonly topP: 1
  readonly maxTokens: number
}

export interface DirectionResult {
  readonly requestId: string
  readonly chapterId: string
  readonly requestSha256: string
  readonly outputSha256: string
  readonly identity: DirectorModelIdentity
  readonly parameters: DirectorParameters
  readonly segments: readonly DirectedSegment[]
  readonly warnings: readonly DirectorWarning[]
}

export type DirectorRunState =
  | 'started'
  | 'requesting'
  | 'response_started'
  | 'validating'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface DirectorProgressError {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
}

/** Text-free event suitable for durable SQLite/job progress storage. */
export interface DirectorProgressEvent {
  readonly requestId: string
  readonly chapterId: string
  readonly requestSha256: string
  readonly sequence: number
  readonly occurredAt: string
  readonly state: DirectorRunState
  readonly completedPassages: number
  readonly totalPassages: number
  readonly message: string
  readonly error?: DirectorProgressError
}

/** Minimal persistence port; the M1 application layer should back this with its job store. */
export interface DirectorProgressStore {
  append(event: DirectorProgressEvent): Promise<void>
}

export interface DirectionOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly maxTokens?: number
}

export interface DirectorHealth {
  readonly status: string
  readonly selectedModelAvailable: boolean
  readonly modelIds: readonly string[]
}

/** Minimal port intentionally independent of the concurrently finalized issue #29 domain types. */
export interface DirectorModel {
  readonly identity: DirectorModelIdentity
  health(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<DirectorHealth>
  direct(request: DirectionRequest, options?: DirectionOptions): Promise<DirectionResult>
}
