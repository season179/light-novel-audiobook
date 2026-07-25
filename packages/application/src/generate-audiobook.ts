import type { AudiobookJob, AudiobookOutput, Book, VoiceCast } from '@light-novel-audiobook/domain'
import { DomainError } from '@light-novel-audiobook/domain'
import { DirectAudiobook } from './direct-audiobook.js'
import type { PendingFallbackApproval } from './fallback-approval.js'
import type {
  AudioAssembler,
  DirectorModel,
  EpubExtractor,
  FallbackApprovalRepository,
  JobRepository,
  SpeechEngineFactory,
} from './ports.js'
import { RenderAudiobook } from './render-audiobook.js'
import {
  type FallbackApprovalPolicy,
  ReviewFallbackApprovals,
} from './review-fallback-approvals.js'

export interface GenerateAudiobookCommand {
  readonly jobId: string
  readonly epubPath: string
  readonly epubSha256: string
  readonly voices: VoiceCast
  /** Explicitly takes over a job known to have lost its worker; never use for an active request. */
  readonly recoverAbandoned?: boolean
  /**
   * How this book's unresolved speakers are decided. Defaults to `'pre-approve-book-fallback'`: the
   * M1 answer, one decision up front recorded as per-segment records, so a 2,328-passage book does
   * not stop for a click per line while revoking one speaker still invalidates only that speaker.
   */
  readonly fallbackApprovalPolicy?: FallbackApprovalPolicy
}

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
  readonly directorModel: DirectorModel
  /**
   * Replaces the former `speechEngine` instance. The engine cannot be built until the approval
   * catalog exists, which is only after direction; see `SpeechEngineFactory`.
   */
  readonly speechEngineFactory: SpeechEngineFactory
  readonly audioAssembler: AudioAssembler
  readonly jobs: JobRepository
  readonly approvals: FallbackApprovalRepository
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

  constructor(dependencies: GenerateAudiobookDependencies) {
    this.direction = new DirectAudiobook({
      epubExtractor: dependencies.epubExtractor,
      directorModel: dependencies.directorModel,
      speechEngineFactory: dependencies.speechEngineFactory,
      audioAssembler: dependencies.audioAssembler,
      jobs: dependencies.jobs,
    })
    this.rendering = new RenderAudiobook({
      speechEngineFactory: dependencies.speechEngineFactory,
      audioAssembler: dependencies.audioAssembler,
      jobs: dependencies.jobs,
      approvals: dependencies.approvals,
    })
    this.review = new ReviewFallbackApprovals({
      jobs: dependencies.jobs,
      approvals: dependencies.approvals,
      now: dependencies.now,
    })
    this.jobs = dependencies.jobs
  }

  async execute(command: GenerateAudiobookCommand): Promise<GenerateAudiobookResult> {
    const policy = command.fallbackApprovalPolicy ?? 'pre-approve-book-fallback'
    const existing = await this.jobs.findJob(command.jobId)
    if (
      existing !== undefined &&
      existing.commandIdentity !== null &&
      existing.commandIdentity !== this.direction.commandIdentity(command)
    ) {
      throw new DomainError('Audiobook job result is stale for the requested generation inputs')
    }
    if (existing?.state === 'completed') {
      if (existing.output === null) throw new DomainError('Completed job has no audiobook output')
      return {
        job: existing,
        output: existing.output,
        generatedSegments: 0,
        reusedSegments: existing.progress.totalSegments,
        recordedFallbackApprovals: 0,
      }
    }

    // A job already awaiting review is resumed from its persisted script. Re-directing it would
    // burn the director again and, worse, could return different delivery for every segment and so
    // restale audio that no decision touched.
    const directed =
      existing?.state === 'awaiting_review'
        ? await this.loadDirected(existing)
        : (await this.direction.execute(command)).book

    const reconciliation = await this.review.reconcile({ book: directed, policy })
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
