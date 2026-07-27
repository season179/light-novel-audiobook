import type { AudiobookJob, Book } from '@light-novel-audiobook/domain'
import { DirectAudiobook, type DirectAudiobookCommand } from './direct-audiobook.js'
import type { PendingFallbackApproval, PersistedFallbackApproval } from './fallback-approval.js'
import type {
  AudioAssembler,
  DirectorModelFactory,
  EpubExtractor,
  FallbackApprovalRepository,
  JobRepository,
  SpeechEngineFactory,
} from './ports.js'
import { ReviewFallbackApprovals } from './review-fallback-approvals.js'

/** @deprecated Prefer the explicit `DirectAudiobook` operation. */
export type GenerateAudiobookCommand = DirectAudiobookCommand

/**
 * Direction-only compatibility result. Audio is deliberately absent: generation now always rests
 * at review and rendering is a separate confirmed operation.
 */
export interface GenerateAudiobookResult {
  readonly job: AudiobookJob
  readonly book: Book
  readonly commandIdentity: string
  readonly pendingFallbackApprovals: readonly PendingFallbackApproval[]
  readonly recordedFallbackApprovals: readonly PersistedFallbackApproval[]
}

export interface GenerateAudiobookDependencies {
  readonly epubExtractor: EpubExtractor
  readonly directorModelFactory: DirectorModelFactory
  readonly speechEngineFactory: SpeechEngineFactory
  readonly audioAssembler: AudioAssembler
  readonly jobs: JobRepository
  readonly approvals: FallbackApprovalRepository
  /** Injected so reconciliation decisions are reproducible in tests. */
  readonly now?: (() => Date) | undefined
}

/**
 * Legacy Stage-A facade retained for source compatibility with tests and integrations.
 *
 * It no longer composes direction and rendering. It directs, reconciles the live fallback ledger so
 * the review projection is current, and returns with the job unconditionally `awaiting_review`.
 * New production callers use `DirectAudiobook` directly and invoke `RenderAudiobook` separately.
 */
export class GenerateAudiobook {
  private readonly direction: DirectAudiobook
  private readonly review: ReviewFallbackApprovals
  private readonly jobs: JobRepository

  constructor(dependencies: GenerateAudiobookDependencies) {
    this.direction = new DirectAudiobook(dependencies)
    this.jobs = dependencies.jobs
    this.review = new ReviewFallbackApprovals({
      jobs: dependencies.jobs,
      approvals: dependencies.approvals,
      now: dependencies.now,
    })
  }

  commandIdentity(command: GenerateAudiobookCommand): string {
    return this.direction.commandIdentity(command)
  }

  async execute(command: GenerateAudiobookCommand): Promise<GenerateAudiobookResult> {
    // Compatibility only: old composed callers invoke this facade again after a render/assembly
    // failure. Return the persisted script without replaying Stage A; their separate renderer can
    // then use the new stage-local resume semantics.
    const interrupted = await this.jobs.findJob(command.jobId)
    if (
      interrupted !== undefined &&
      interrupted.state === 'failed' &&
      (interrupted.stage === 'rendering' || interrupted.stage === 'assembling')
    ) {
      const commandIdentity = this.direction.commandIdentity(command)
      if (interrupted.commandIdentity !== commandIdentity || interrupted.bookId === null) {
        throw new Error('Audiobook job result is stale for the requested generation inputs')
      }
      const book = await this.jobs.findBook(interrupted.bookId)
      if (book === undefined) throw new Error('Persisted directed book is missing')
      const reconciliation = await this.review.reconcile({
        book,
        warnings: interrupted.warnings,
      })
      return {
        job: interrupted,
        book,
        commandIdentity,
        pendingFallbackApprovals: reconciliation.pending,
        recordedFallbackApprovals: reconciliation.created,
      }
    }

    const directed = await this.direction.execute(command)
    const reconciliation = await this.review.reconcile({
      book: directed.book,
      warnings: directed.job.warnings,
    })
    return {
      ...directed,
      pendingFallbackApprovals: reconciliation.pending,
      recordedFallbackApprovals: reconciliation.created,
    }
  }
}
