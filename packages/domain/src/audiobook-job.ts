import { DomainError, InvalidStateTransitionError } from './errors.js'
import { type AudiobookOutput, OutputVersion } from './output-version.js'
import type { FallbackReason } from './segment.js'

export const AUDIOBOOK_JOB_STATES = [
  'pending',
  'running',
  'abandoned',
  'failed',
  'completed',
] as const
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
  running: ['abandoned', 'failed', 'completed'],
  abandoned: ['running'],
  failed: ['running'],
  completed: [],
}

const stableBookIdPattern = /^book-[a-f\d]{24}$/i
const stableSegmentIdPattern = /^book-[a-f\d]{24}-ch(\d{4})-p(\d{6})-s(\d{4})$/i
const stableSimpleIdPattern = /^[a-z\d](?:[a-z\d._:-]*[a-z\d])?$/i

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

export interface AudiobookOutputSnapshot {
  readonly version: number
  readonly m4bPath: string
  readonly chapters: readonly {
    readonly chapterId: string
    readonly path: string
  }[]
}

/** JSON-safe persistence shape for issue #27's repository adapter. */
export interface AudiobookJobSnapshot {
  readonly schemaVersion: 2
  readonly id: string
  readonly state: AudiobookJobState
  readonly stage: AudiobookJobStage
  readonly commandIdentity: string | null
  readonly bookId: string | null
  readonly progress: AudiobookJobProgress
  readonly warnings: readonly FallbackVoiceWarning[]
  readonly output: AudiobookOutputSnapshot | null
  readonly error: string | null
}

export class AudiobookJob {
  readonly id: string
  private currentState: AudiobookJobState = 'pending'
  private currentStage: AudiobookJobStage = 'extracting'
  private boundCommandIdentity: string | null = null
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
    if (id.trim().length === 0) throw new DomainError('Audiobook job ID is required')
    this.id = id
  }

  get state(): AudiobookJobState {
    return this.currentState
  }

  get stage(): AudiobookJobStage {
    return this.currentStage
  }

  get commandIdentity(): string | null {
    return this.boundCommandIdentity
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

  bindCommand(commandIdentity: string): void {
    if (!/^[a-f\d]{64}$/i.test(commandIdentity)) {
      throw new DomainError('Generation command identity must be a SHA-256 value')
    }
    const normalized = commandIdentity.toLowerCase()
    if (this.boundCommandIdentity !== null && this.boundCommandIdentity !== normalized) {
      throw new DomainError('Audiobook job is bound to different generation inputs')
    }
    if (this.currentState !== 'pending' && this.boundCommandIdentity === null) {
      throw new DomainError('A started job cannot be bound retroactively')
    }
    this.boundCommandIdentity = normalized
  }

  start(): void {
    if (this.currentState !== 'pending') {
      throw new InvalidStateTransitionError('AudiobookJob', this.currentState, 'running')
    }
    if (this.boundCommandIdentity === null) {
      throw new DomainError('Generation inputs must be bound before a job starts')
    }
    this.currentState = 'running'
    this.report(null, 'Extracting EPUB')
  }

  retry(): void {
    if (this.currentState !== 'failed') {
      throw new InvalidStateTransitionError('AudiobookJob', this.currentState, 'running')
    }
    this.resetForRecovery('Retrying from EPUB extraction')
  }

  markAbandoned(): void {
    if (this.currentState !== 'running') {
      throw new InvalidStateTransitionError('AudiobookJob', this.currentState, 'abandoned')
    }
    this.currentState = 'abandoned'
    this.currentProgress = Object.freeze({
      ...this.currentProgress,
      latestMessage: 'Job marked abandoned',
    })
  }

  recoverAbandoned(): void {
    if (this.currentState !== 'abandoned') {
      throw new InvalidStateTransitionError('AudiobookJob', this.currentState, 'running')
    }
    this.resetForRecovery('Recovering abandoned job from EPUB extraction')
  }

  attachBook(bookId: string): void {
    if (this.currentState !== 'running' || this.currentStage !== 'extracting') {
      throw new DomainError('A book can only be attached during extraction')
    }
    if (bookId.trim().length === 0) throw new DomainError('Book ID is required')
    if (this.attachedBookId !== null && this.attachedBookId !== bookId) {
      throw new DomainError('A job cannot change its source book')
    }
    this.attachedBookId = bookId
  }

  beginDirection(): void {
    if (this.currentState !== 'running' || this.currentStage !== 'extracting') {
      throw new InvalidStateTransitionError('AudiobookJob stage', this.currentStage, 'directing')
    }
    if (this.attachedBookId === null) {
      throw new DomainError('A book must be attached before direction')
    }
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
    if (
      this.currentState !== 'running' ||
      latestMessage.trim().length === 0 ||
      (currentChapterId !== null &&
        (currentChapterId.trim().length === 0 ||
          (this.currentStage !== 'directing' && this.currentStage !== 'rendering')))
    ) {
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
    if (segmentId.trim().length === 0) throw new DomainError('Completed segment ID is required')
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
    this.validateWarning(warning, this.attachedBookId)
    if (this.fallbackWarnings.some((existing) => existing.segmentId === warning.segmentId)) return
    this.fallbackWarnings = Object.freeze([...this.fallbackWarnings, Object.freeze({ ...warning })])
  }

  complete(output: AudiobookOutput): void {
    if (this.currentState !== 'running' || this.currentStage !== 'assembling') {
      throw new InvalidStateTransitionError('AudiobookJob', this.currentState, 'completed')
    }
    if (this.attachedBookId === null || this.currentProgress.totalSegments < 1) {
      throw new DomainError('Completed jobs require a book and rendered segments')
    }
    this.validateOutput(output)
    this.validateOutputContext(output, this.attachedBookId, this.currentProgress.totalSegments)
    this.currentStage = 'completed'
    this.currentState = 'completed'
    this.completedOutput = Object.freeze({
      ...output,
      chapters: Object.freeze(output.chapters.map((chapter) => Object.freeze({ ...chapter }))),
    })
    this.reportCompleted('Audiobook completed')
  }

  fail(error: string): void {
    if (this.currentState !== 'running') {
      throw new InvalidStateTransitionError('AudiobookJob', this.currentState, 'failed')
    }
    if (error.trim().length === 0) throw new DomainError('Failure message is required')
    this.currentState = 'failed'
    this.failureMessage = error
    this.currentProgress = Object.freeze({ ...this.currentProgress, latestMessage: error })
  }

  snapshot(): AudiobookJobSnapshot {
    return Object.freeze({
      schemaVersion: 2,
      id: this.id,
      state: this.currentState,
      stage: this.currentStage,
      commandIdentity: this.boundCommandIdentity,
      bookId: this.attachedBookId,
      progress: Object.freeze({ ...this.currentProgress }),
      warnings: Object.freeze(
        this.fallbackWarnings.map((warning) => Object.freeze({ ...warning })),
      ),
      output:
        this.completedOutput === null
          ? null
          : Object.freeze({
              version: this.completedOutput.version.value,
              m4bPath: this.completedOutput.m4bPath,
              chapters: Object.freeze(
                this.completedOutput.chapters.map((chapter) => Object.freeze({ ...chapter })),
              ),
            }),
      error: this.failureMessage,
    })
  }

  static reconstitute(snapshot: AudiobookJobSnapshot): AudiobookJob {
    AudiobookJob.validateSnapshot(snapshot)
    const job = new AudiobookJob(snapshot.id)
    job.currentState = snapshot.state
    job.currentStage = snapshot.stage
    job.boundCommandIdentity = snapshot.commandIdentity?.toLowerCase() ?? null
    job.attachedBookId = snapshot.bookId
    job.currentProgress = Object.freeze({ ...snapshot.progress })
    job.fallbackWarnings = Object.freeze(
      snapshot.warnings.map((warning) => Object.freeze({ ...warning })),
    )
    job.completedOutput =
      snapshot.output === null
        ? null
        : Object.freeze({
            version: new OutputVersion(snapshot.output.version),
            m4bPath: snapshot.output.m4bPath,
            chapters: Object.freeze(
              snapshot.output.chapters.map((chapter) => Object.freeze({ ...chapter })),
            ),
          })
    job.failureMessage = snapshot.error
    return job
  }

  static canTransition(from: AudiobookJobState, to: AudiobookJobState): boolean {
    return allowedStateTransitions[from].includes(to)
  }

  static canAdvanceStage(from: AudiobookJobStage, to: AudiobookJobStage): boolean {
    return nextStage[from] === to
  }

  private static validateSnapshot(snapshot: AudiobookJobSnapshot): void {
    if (snapshot.schemaVersion !== 2 || snapshot.id.trim().length === 0) {
      throw new DomainError('Unsupported or invalid audiobook job snapshot')
    }
    if (
      !AUDIOBOOK_JOB_STATES.includes(snapshot.state) ||
      !AUDIOBOOK_JOB_STAGES.includes(snapshot.stage)
    ) {
      throw new DomainError('Audiobook job snapshot has an invalid state or stage')
    }
    if (snapshot.commandIdentity !== null && !/^[a-f\d]{64}$/i.test(snapshot.commandIdentity)) {
      throw new DomainError('Audiobook job snapshot has an invalid command identity')
    }
    if (snapshot.state !== 'pending' && snapshot.commandIdentity === null) {
      throw new DomainError('Started audiobook job snapshots require a command identity')
    }
    if (snapshot.state === 'pending' && snapshot.stage !== 'extracting') {
      throw new DomainError('Pending audiobook job snapshots must be extracting')
    }
    if (snapshot.bookId !== null && snapshot.bookId.trim().length === 0) {
      throw new DomainError('Audiobook job snapshot has an invalid book ID')
    }
    if ((snapshot.stage === 'completed') !== (snapshot.state === 'completed')) {
      throw new DomainError('Only completed jobs can use the completed stage')
    }
    if ((snapshot.output !== null) !== (snapshot.state === 'completed')) {
      throw new DomainError('Only completed jobs can contain output')
    }
    if ((snapshot.error !== null) !== (snapshot.state === 'failed') || snapshot.error === '') {
      throw new DomainError('Only failed jobs can contain a nonempty error')
    }
    const progress = snapshot.progress
    if (
      !Number.isSafeInteger(progress.completedSegments) ||
      !Number.isSafeInteger(progress.totalSegments) ||
      progress.completedSegments < 0 ||
      progress.totalSegments < 0 ||
      progress.completedSegments > progress.totalSegments ||
      progress.latestMessage.trim().length === 0 ||
      (progress.currentChapterId !== null && progress.currentChapterId.trim().length === 0)
    ) {
      throw new DomainError('Audiobook job snapshot has invalid progress')
    }
    AudiobookJob.validateSnapshotLifecycle(snapshot)
    const validator = new AudiobookJob(snapshot.id)
    const warningSegmentIds = new Set<string>()
    for (const warning of snapshot.warnings) {
      validator.validateWarning(warning, snapshot.bookId)
      if (warningSegmentIds.has(warning.segmentId)) {
        throw new DomainError('Audiobook job snapshot has duplicate fallback warnings')
      }
      warningSegmentIds.add(warning.segmentId)
    }
    if (snapshot.output !== null) {
      const output = {
        version: new OutputVersion(snapshot.output.version),
        m4bPath: snapshot.output.m4bPath,
        chapters: snapshot.output.chapters,
      }
      validator.validateOutput(output)
      validator.validateOutputContext(output, snapshot.bookId, snapshot.progress.totalSegments)
    }
  }

  private static validateSnapshotLifecycle(snapshot: AudiobookJobSnapshot): void {
    const { progress } = snapshot
    const activeOrInterrupted =
      snapshot.state === 'running' || snapshot.state === 'failed' || snapshot.state === 'abandoned'

    if (snapshot.state === 'pending') {
      if (
        snapshot.stage !== 'extracting' ||
        snapshot.bookId !== null ||
        progress.completedSegments !== 0 ||
        progress.totalSegments !== 0 ||
        progress.currentChapterId !== null ||
        progress.latestMessage !== 'Waiting to start' ||
        snapshot.warnings.length !== 0
      ) {
        throw new DomainError('Pending audiobook job snapshot is unreachable')
      }
      return
    }

    if (snapshot.state === 'failed' && progress.latestMessage !== snapshot.error) {
      throw new DomainError('Failed audiobook job snapshot must report its error')
    }
    if (snapshot.state === 'abandoned' && progress.latestMessage !== 'Job marked abandoned') {
      throw new DomainError('Abandoned audiobook job snapshot has invalid progress')
    }

    switch (snapshot.stage) {
      case 'extracting':
        if (
          !activeOrInterrupted ||
          progress.completedSegments !== 0 ||
          progress.totalSegments !== 0 ||
          progress.currentChapterId !== null ||
          snapshot.warnings.length !== 0
        ) {
          throw new DomainError('Extracting audiobook job snapshot is unreachable')
        }
        break
      case 'directing':
        if (
          !activeOrInterrupted ||
          snapshot.bookId === null ||
          progress.completedSegments !== 0 ||
          progress.totalSegments !== 0
        ) {
          throw new DomainError('Directing audiobook job snapshot is unreachable')
        }
        break
      case 'rendering':
        if (!activeOrInterrupted || snapshot.bookId === null || progress.totalSegments < 1) {
          throw new DomainError('Rendering audiobook job snapshot is unreachable')
        }
        break
      case 'assembling':
        if (
          !activeOrInterrupted ||
          snapshot.bookId === null ||
          progress.totalSegments < 1 ||
          progress.completedSegments !== progress.totalSegments ||
          progress.currentChapterId !== null
        ) {
          throw new DomainError('Assembling audiobook job snapshot is unreachable')
        }
        break
      case 'completed':
        if (
          snapshot.state !== 'completed' ||
          snapshot.commandIdentity === null ||
          snapshot.bookId === null ||
          progress.totalSegments < 1 ||
          progress.completedSegments !== progress.totalSegments ||
          progress.currentChapterId !== null ||
          progress.latestMessage !== 'Audiobook completed' ||
          snapshot.output === null
        ) {
          throw new DomainError('Completed audiobook job snapshot is unreachable')
        }
        break
    }
  }

  private validateWarning(warning: FallbackVoiceWarning, bookId: string | null): void {
    if (warning === null || typeof warning !== 'object') {
      throw new DomainError('Fallback warning is invalid')
    }
    const segmentMatch =
      typeof warning.segmentId === 'string' ? stableSegmentIdPattern.exec(warning.segmentId) : null
    const stableSegmentPositions =
      segmentMatch !== null &&
      Number(segmentMatch[1]) > 0 &&
      Number(segmentMatch[2]) > 0 &&
      Number(segmentMatch[3]) > 0
    const stableVoiceId =
      typeof warning.voiceProfileId === 'string' &&
      stableSimpleIdPattern.test(warning.voiceProfileId)
    const stableSpeakerId =
      typeof warning.speakerId === 'string' && stableSimpleIdPattern.test(warning.speakerId)
    const validSpeakerReason =
      (warning.reason === 'unresolved_speaker' && warning.speakerId === null) ||
      (warning.reason === 'missing_speaker_voice' && stableSpeakerId)
    if (
      !stableSegmentPositions ||
      bookId === null ||
      !warning.segmentId.startsWith(`${bookId}-ch`) ||
      !stableVoiceId ||
      !validSpeakerReason
    ) {
      throw new DomainError('Fallback warning is invalid')
    }
  }

  private validateOutput(output: AudiobookOutput): void {
    const paths = [output.m4bPath, ...output.chapters.map((chapter) => chapter.path)]
    const chapterIds = output.chapters.map((chapter) => chapter.chapterId)
    if (
      output.chapters.length === 0 ||
      paths.some((path) => path.trim().length === 0) ||
      new Set(paths).size !== paths.length ||
      chapterIds.some((chapterId) => chapterId.trim().length === 0) ||
      new Set(chapterIds).size !== chapterIds.length
    ) {
      throw new DomainError('Completed output paths must be nonempty and pairwise distinct')
    }
  }

  private validateOutputContext(
    output: AudiobookOutput,
    bookId: string | null,
    totalSegments: number,
  ): void {
    if (
      bookId === null ||
      !stableBookIdPattern.test(bookId) ||
      totalSegments < 1 ||
      output.chapters.length > totalSegments ||
      output.chapters.some((chapter) => {
        const expectedPrefix = `${bookId}-ch`
        if (!chapter.chapterId.startsWith(expectedPrefix)) return true
        const suffix = chapter.chapterId.slice(expectedPrefix.length)
        return !/^\d{4}$/.test(suffix) || Number(suffix) < 1
      })
    ) {
      throw new DomainError('Completed output chapters do not belong to the job book')
    }
  }

  private resetForRecovery(message: string): void {
    this.currentState = 'running'
    this.currentStage = 'extracting'
    this.currentProgress = Object.freeze({
      currentChapterId: null,
      completedSegments: 0,
      totalSegments: 0,
      latestMessage: message,
    })
    this.fallbackWarnings = Object.freeze([])
    this.completedOutput = null
    this.failureMessage = null
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
