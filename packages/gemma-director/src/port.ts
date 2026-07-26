import type { DirectedChapter } from '@light-novel-audiobook/application'
import type {
  Book,
  Chapter,
  DirectedSegment as DomainDirectedSegment,
} from '@light-novel-audiobook/domain'

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

export interface DirectorChapterContext {
  readonly speakers: readonly DirectorSpeaker[]
  readonly narratorSpeakerId: string
  readonly fallbackSpeakerId: string
  readonly storyContext?: string
}

/** Supplies the story bible/cast context that is deliberately absent from the domain Book. */
export interface DirectorContextProvider {
  forChapter(book: Book, chapter: Chapter): Promise<DirectorChapterContext>
}

export interface DirectionRequest extends DirectorChapterContext {
  /** Stable application run/job ID used by persisted progress records. */
  readonly requestId: string
  readonly bookId: string
  readonly bookTitle: string
  readonly bookAuthor: string | null
  readonly bookSourceSha256: string
  readonly chapterId: string
  readonly chapterPosition: number
  readonly chapterTitle: string
  readonly passages: readonly DirectorSourcePassage[]
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

/** A source-relative model annotation before mapping to issue #29's DirectedSegment. */
export interface DirectedAnnotation extends DomainDirectedSegment {
  readonly sourceStart: number
  readonly sourceEnd: number
  readonly speakerId: string
}

export type DirectorWarningCode =
  | 'unresolved_speaker'
  | 'low_confidence_speaker'
  | 'low_confidence_kind'

export interface DirectorWarning {
  readonly code: DirectorWarningCode
  readonly sourcePassageId: string
  readonly sourceStart: number
  readonly sourceEnd: number
  readonly candidateSpeakerId: string | null
  readonly confidence: number
  readonly confidenceThreshold: number
  readonly message: string
  readonly reviewRequired: true
  /** False for narrator-owned segments: they flag for review without rerouting the voice. */
  readonly usesFallback: boolean
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
  readonly confidenceThreshold: number
}

/** Exact issue #29 result plus review data retained by the concrete adapter. */
export interface GemmaDirectedChapter extends DirectedChapter {
  readonly chapterId: string
  readonly segments: readonly DomainDirectedSegment[]
  readonly requestId: string
  readonly requestSha256: string
  readonly outputSha256: string
  readonly directorIdentity: string
  readonly modelIdentity: DirectorModelIdentity
  readonly parameters: DirectorParameters
  readonly warnings: readonly DirectorWarning[]
}

export type DirectorRunState =
  | 'started'
  | 'requesting'
  | 'response_started'
  | 'streaming'
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
  readonly warningCount?: number
  readonly message: string
  readonly error?: DirectorProgressError
}

export interface DirectorProgressStore {
  append(event: DirectorProgressEvent): Promise<void>
}

export interface DirectionOptions {
  readonly signal?: AbortSignal
  /**
   * Whole-chapter deadline in milliseconds, spanning all window requests and retries. Defaults
   * to 60 minutes, the representative-chapter budget PLAN locks. The per-request timeout is the
   * adapter-owned `requestTimeoutMs` constructor setting.
   */
  readonly timeoutMs?: number
}

export interface DirectorHealth {
  readonly status: string
  readonly selectedModelAvailable: boolean
  readonly modelIds: readonly string[]
}

/** Owns or delegates start and shutdown/unload of the exact local runtime used by this adapter. */
export interface DirectorRuntimeLifecycle {
  /**
   * Loads the runtime and its weights onto the GPU. The adapter calls this only while it already
   * holds the exclusive GPU lease, so VRAM residency can never precede the lease. Implementations
   * must be idempotent, must resolve only once the runtime is ready to serve requests, and must
   * either settle within its normal startup bound or be made to settle by `release()`. An unsettled
   * start must not be able to outlive the adapter. The lifecycle implementation owns these bounds
   * because it knows how long a cold weight load and its own pre-spawn operations may take.
   */
  start(): Promise<void>
  /**
   * Unloads the runtime and frees the GPU, and must not resolve until that is true — process
   * exited, port free. It must synchronously prohibit future spawns, bound its wait for an in-flight
   * `start()` to settle, and reject rather than report success if runtime state remains unknown.
   * Observing "no child yet" in a pre-spawn window and returning is exactly the co-residency hole
   * the lease exists to prevent.
   */
  release(): Promise<void>
}
