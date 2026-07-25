import { DomainError, InvalidStateTransitionError } from './errors.js'
import type { AudiobookOutput } from './output-version.js'
import type { FallbackReason } from './segment.js'

export const AUDIOBOOK_JOB_STATES = ['pending', 'running', 'failed', 'completed'] as const
export type AudiobookJobState = (typeof AUDIOBOOK_JOB_STATES)[number]

export const AUDIOBOOK_JOB_STAGES = [
  'extracting',
  'directing',
  'rendering',
  'assembling',
  'completed',
] as const
export type AudiobookJobStage = (typeof AUDIOBOOK_JOB_STAGES)[number]

const nextStage: Readonly<Partial<Record<AudiobookJobStage, AudiobookJobStage>>> = {
  extracting: 'directing',
  directing: 'rendering',
  rendering: 'assembling',
  assembling: 'completed',
}

const allowedStateTransitions: Readonly<Record<AudiobookJobState, readonly AudiobookJobState[]>> = {
  pending: ['running'],
  running: ['failed', 'completed'],
  failed: ['running'],
  completed: [],
}

export interface FallbackVoiceWarning {
  readonly segmentId: string
  readonly speakerId: string | null
  readonly voiceProfileId: string
  readonly reason: FallbackReason
}

export interface AudiobookJobProgress {
  readonly currentChapterId: string | null
  readonly completedSegments: number
  readonly totalSegments: number
  readonly latestMessage: string
}

export class AudiobookJob {
  readonly id: string
  private currentState: AudiobookJobState = 'pending'
  private currentStage: AudiobookJobStage = 'extracting'
  private attachedBookId: string | null = null
  private currentProgress: AudiobookJobProgress = Object.freeze({
    currentChapterId: null,
    completedSegments: 0,
    totalSegments: 0,
    latestMessage: 'Waiting to start',
  })
  private fallbackWarnings: readonly FallbackVoiceWarning[] = Object.freeze([])
  private completedOutput: AudiobookOutput | null = null
  private failureMessage: string | null = null

  constructor(id: string) {
    if (id.length === 0) throw new DomainError('Audiobook job ID is required')
    this.id = id
  }

  get state(): AudiobookJobState {
    return this.currentState
  }

  get stage(): AudiobookJobStage {
    return this.currentStage
  }

  get bookId(): string | null {
    return this.attachedBookId
  }

  get progress(): AudiobookJobProgress {
    return this.currentProgress
  }

  get warnings(): readonly FallbackVoiceWarning[] {
    return this.fallbackWarnings
  }

  get output(): AudiobookOutput | null {
    return this.completedOutput
  }

  get error(): string | null {
    return this.failureMessage
  }

  start(): void {
    if (this.currentState !== 'pending') {
      throw new InvalidStateTransitionError('AudiobookJob', this.currentState, 'running')
    }
    this.currentState = 'running'
    this.report(null, 'Extracting EPUB')
  }

  /** A failed or abandoned run starts deterministically from extraction and reuses valid audio. */
  restart(): void {
    if (this.currentState !== 'failed' && this.currentState !== 'running') {
      throw new InvalidStateTransitionError('AudiobookJob', this.currentState, 'running')
    }
    this.currentState = 'running'
    this.currentStage = 'extracting'
    this.currentProgress = Object.freeze({
      currentChapterId: null,
      completedSegments: 0,
      totalSegments: 0,
      latestMessage: 'Restarting from EPUB extraction',
    })
    this.fallbackWarnings = Object.freeze([])
    this.completedOutput = null
    this.failureMessage = null
  }

  attachBook(bookId: string): void {
    if (this.currentState !== 'running' || this.currentStage !== 'extracting') {
      throw new DomainError('A book can only be attached during extraction')
    }
    if (bookId.length === 0) throw new DomainError('Book ID is required')
    if (this.attachedBookId !== null && this.attachedBookId !== bookId) {
      throw new DomainError('A job cannot change its source book')
    }
    this.attachedBookId = bookId
  }

  beginDirection(): void {
    this.advance('directing', 'Directing chapters')
  }

  beginRendering(totalSegments: number): void {
    if (!Number.isSafeInteger(totalSegments) || totalSegments < 1) {
      throw new DomainError('Rendering requires a positive segment count')
    }
    this.advance('rendering', 'Rendering speech')
    this.currentProgress = Object.freeze({
      ...this.currentProgress,
      completedSegments: 0,
      totalSegments,
    })
  }

  beginAssembly(): void {
    if (this.currentProgress.completedSegments !== this.currentProgress.totalSegments) {
      throw new DomainError('All segments must complete before assembly')
    }
    this.advance('assembling', 'Assembling audiobook')
  }

  report(currentChapterId: string | null, latestMessage: string): void {
    if (this.currentState !== 'running' || latestMessage.length === 0) {
      throw new DomainError('Progress can only be reported by a running job with a message')
    }
    this.currentProgress = Object.freeze({
      ...this.currentProgress,
      currentChapterId,
      latestMessage,
    })
  }

  recordSegmentCompleted(segmentId: string): void {
    if (this.currentState !== 'running' || this.currentStage !== 'rendering') {
      throw new DomainError('Segments can only complete during rendering')
    }
    if (this.currentProgress.completedSegments >= this.currentProgress.totalSegments) {
      throw new DomainError('Completed segment count cannot exceed the total')
    }
    this.currentProgress = Object.freeze({
      ...this.currentProgress,
      completedSegments: this.currentProgress.completedSegments + 1,
      latestMessage: `Completed segment ${segmentId}`,
    })
  }

  addFallbackWarning(warning: FallbackVoiceWarning): void {
    if (this.currentState !== 'running' || this.currentStage !== 'directing') {
      throw new DomainError('Fallback warnings can only be added during direction')
    }
    if (this.fallbackWarnings.some((existing) => existing.segmentId === warning.segmentId)) return
    this.fallbackWarnings = Object.freeze([...this.fallbackWarnings, Object.freeze({ ...warning })])
  }

  complete(output: AudiobookOutput): void {
    if (this.currentState !== 'running' || this.currentStage !== 'assembling') {
      throw new InvalidStateTransitionError('AudiobookJob', this.currentState, 'completed')
    }
    if (
      output.m4bPath.length === 0 ||
      output.chapters.some((chapter) => chapter.path.length === 0)
    ) {
      throw new DomainError('Completed output paths are required')
    }
    this.currentStage = 'completed'
    this.currentState = 'completed'
    this.completedOutput = Object.freeze({
      ...output,
      chapters: Object.freeze([...output.chapters]),
    })
    this.reportCompleted('Audiobook completed')
  }

  fail(error: string): void {
    if (this.currentState !== 'running') {
      throw new InvalidStateTransitionError('AudiobookJob', this.currentState, 'failed')
    }
    if (error.length === 0) throw new DomainError('Failure message is required')
    this.currentState = 'failed'
    this.failureMessage = error
    this.currentProgress = Object.freeze({ ...this.currentProgress, latestMessage: error })
  }

  static canTransition(from: AudiobookJobState, to: AudiobookJobState): boolean {
    return allowedStateTransitions[from].includes(to)
  }

  static canAdvanceStage(from: AudiobookJobStage, to: AudiobookJobStage): boolean {
    return nextStage[from] === to
  }

  private advance(to: AudiobookJobStage, message: string): void {
    if (this.currentState !== 'running' || nextStage[this.currentStage] !== to) {
      throw new InvalidStateTransitionError('AudiobookJob stage', this.currentStage, to)
    }
    this.currentStage = to
    this.report(null, message)
  }

  private reportCompleted(message: string): void {
    this.currentProgress = Object.freeze({
      ...this.currentProgress,
      currentChapterId: null,
      latestMessage: message,
    })
  }
}
