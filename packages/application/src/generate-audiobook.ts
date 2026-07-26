import type { AudiobookJob, AudiobookOutput, Book, VoiceCast } from '@light-novel-audiobook/domain'
import { DomainError } from '@light-novel-audiobook/domain'
import { CompletedOutputAuthority } from './completed-output.js'
import { DirectAudiobook } from './direct-audiobook.js'
import type { PendingFallbackApproval } from './fallback-approval.js'
import type {
  AudioAssembler,
  DirectChapterOptions,
  DirectorModelFactory,
  EpubExtractor,
  FallbackApprovalRepository,
  JobRepository,
  SpeechEngineFactory,
} from './ports.js'
import { RenderAudiobook } from './render-audiobook.js'
import { ReviewFallbackApprovals } from './review-fallback-approvals.js'

export interface GenerateAudiobookCommand {
  readonly jobId: string
  readonly epubPath: string
  readonly epubSha256: string
  readonly voices: VoiceCast
  /** Operational cancellation/deadline controls; deliberately excluded from content identity. */
  readonly directorOptions?: DirectChapterOptions | undefined
  /** Explicitly takes over a job known to have lost its worker; never use for an active request. */
  readonly recoverAbandoned?: boolean
}

/**
 * There is deliberately **no** approval policy field on this command.
 *
 * Issue #45's round-2 review found that an optional policy whose omission pre-approved every
 * fallback segment was the old `'auto-approve'` stand-in renamed: the records it wrote carried a
 * timestamp but no actor and no review operation, so any consumer that merely updated its
 * constructor got silent approval by default. There is now no field through which a default could be
 * inserted by this use case or by composition wiring. Approvals exist only because
 * `ReviewFallbackApprovals` recorded a human decision — per segment, or once for the whole book via
 * `grantBookFallback`. A run that finds undecided unresolved speakers stops at `awaiting_review`.
 */

export interface GenerateAudiobookResult {
  readonly job: AudiobookJob
  readonly output: AudiobookOutput
  readonly generatedSegments: number
  readonly reusedSegments: number
  /** Decisions this run wrote, one per unresolved-speaker segment it authorized. */
  readonly recordedFallbackApprovals: number
}

export interface GenerateAudiobookDependencies {
  readonly epubExtractor: EpubExtractor
  /** Built only when direction runs; never on a render-only review resume. See `DirectorModelFactory`. */
  readonly directorModelFactory: DirectorModelFactory
  /**
   * Replaces the former `speechEngine` instance. The engine cannot be built until the approval
   * catalog exists, which is only after direction; see `SpeechEngineFactory`.
   */
  readonly speechEngineFactory: SpeechEngineFactory
  readonly audioAssembler: AudioAssembler
  readonly jobs: JobRepository
  readonly approvals: FallbackApprovalRepository
  /** Shared with review and file-open consumers so authorization cannot race a catalog mutation. */
  readonly completedOutputs?: CompletedOutputAuthority | undefined
  /** Injected so a decision time is reproducible in tests; defaults to the wall clock. */
  readonly now?: (() => Date) | undefined
}

/**
 * The one-click upload-to-M4B flow, composed from the two PLAN.md stages rather than being a third
 * implementation of them: direct → reconcile fallback decisions → render.
 *
 * A run that finds unresolved speakers under `'require-explicit-review'` stops with the job awaiting
 * review instead of rendering; `ReviewFallbackApprovals` then decides them and `RenderAudiobook`
 * continues from the persisted script without re-directing.
 */
export class GenerateAudiobook {
  private readonly direction: DirectAudiobook
  private readonly rendering: RenderAudiobook
  private readonly review: ReviewFallbackApprovals
  private readonly jobs: JobRepository
  private readonly completedOutputs: CompletedOutputAuthority

  constructor(dependencies: GenerateAudiobookDependencies) {
    this.direction = new DirectAudiobook({
      epubExtractor: dependencies.epubExtractor,
      directorModelFactory: dependencies.directorModelFactory,
      speechEngineFactory: dependencies.speechEngineFactory,
      audioAssembler: dependencies.audioAssembler,
      jobs: dependencies.jobs,
    })
    this.completedOutputs =
      dependencies.completedOutputs ?? new CompletedOutputAuthority(dependencies.approvals)
    this.rendering = new RenderAudiobook({
      speechEngineFactory: dependencies.speechEngineFactory,
      audioAssembler: dependencies.audioAssembler,
      jobs: dependencies.jobs,
      approvals: dependencies.approvals,
      completedOutputs: this.completedOutputs,
    })
    this.review = new ReviewFallbackApprovals({
      jobs: dependencies.jobs,
      approvals: dependencies.approvals,
      now: dependencies.now,
    })
    this.jobs = dependencies.jobs
  }

  async execute(command: GenerateAudiobookCommand): Promise<GenerateAudiobookResult> {
    const existing = await this.jobs.findJob(command.jobId)
    if (
      existing !== undefined &&
      existing.commandIdentity !== null &&
      existing.commandIdentity !== this.direction.commandIdentity(command)
    ) {
      throw new DomainError('Audiobook job result is stale for the requested generation inputs')
    }
    if (existing?.state === 'completed') {
      const authorization = await this.completedOutputs.authorize(
        existing,
        (output): GenerateAudiobookResult => ({
          job: existing,
          output,
          generatedSegments: 0,
          reusedSegments: existing.progress.totalSegments,
          recordedFallbackApprovals: 0,
        }),
      )
      if (authorization.exposable) return authorization.value
      if (authorization.denial !== 'approval-catalog-moved') {
        throw new DomainError('Completed job has no authorized audiobook output')
      }
      // The stored output is stale. Reopen and continue through persisted review reconciliation;
      // never fall through to direction, which would discard the stable reviewed script.
      existing.reopenForReview()
      await this.jobs.saveJob(existing)
    }

    // A job already awaiting review is resumed from its persisted script. Re-directing it would
    // burn the director again and, worse, could return different delivery for every segment and so
    // restale audio that no decision touched.
    const directed =
      existing?.state === 'awaiting_review'
        ? await this.loadDirected(existing)
        : (await this.direction.execute(command)).book

    const reconciliation = await this.review.reconcile({ book: directed })
    if (reconciliation.pending.length > 0) {
      throw new PendingFallbackReviewError(command.jobId, reconciliation.pending)
    }

    const rendered = await this.rendering.execute({
      jobId: command.jobId,
      voices: command.voices,
    })
    return { ...rendered, recordedFallbackApprovals: reconciliation.created.length }
  }

  private async loadDirected(job: AudiobookJob): Promise<Book> {
    if (job.bookId === null) throw new DomainError('A directed job must have an attached book')
    const book = await this.jobs.findBook(job.bookId)
    if (book === undefined) {
      throw new DomainError(`Approved script for book ${job.bookId} is not persisted`)
    }
    return book
  }
}

/**
 * Raised when generation stopped because unresolved speakers await a human decision. The job is left
 * awaiting review, not failed: nothing went wrong, and PLAN.md:129 says the choice cannot be
 * inferred. Carries the queue so a caller can render the review list without a second read.
 */
export class PendingFallbackReviewError extends DomainError {
  override readonly name = 'PendingFallbackReviewError'
  readonly jobId: string
  readonly pending: readonly PendingFallbackApproval[]

  constructor(jobId: string, pending: readonly PendingFallbackApproval[]) {
    super(
      `Audiobook job ${jobId} is awaiting a fallback decision for ${pending.length} unresolved speaker segment(s)`,
    )
    this.jobId = jobId
    this.pending = Object.freeze([...pending])
  }
}
