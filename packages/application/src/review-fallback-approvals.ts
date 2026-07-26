import { type AudiobookJob, type Book, DomainError } from '@light-novel-audiobook/domain'
import { type ApprovalCatalogAccess, approvalCatalogAccessFor } from './completed-output.js'
import {
  approvalStillDescribes,
  type BookFallbackGrant,
  collectFallbackSubjects,
  createBookFallbackGrant,
  createFallbackApprovalRecord,
  type FallbackApprovalSubject,
  fallbackApprovalExcerpt,
  type PendingFallbackApproval,
  type PersistedFallbackApproval,
} from './fallback-approval.js'
import type { FallbackApprovalRepository, JobRepository } from './ports.js'

export interface FallbackApprovalReconciliation {
  /** The live catalog after reconciliation, in book order. What the speech engine is built with. */
  readonly approved: readonly PersistedFallbackApproval[]
  readonly created: readonly PersistedFallbackApproval[]
  readonly unchanged: readonly PersistedFallbackApproval[]
  /** Decisions removed because their segment or its approved line no longer matches them. */
  readonly invalidated: readonly PersistedFallbackApproval[]
  /** Unresolved speakers still needing a human decision. Rendering cannot start while non-empty. */
  readonly pending: readonly PendingFallbackApproval[]
  /** The book-wide grant these approvals were derived from, if one has been issued. */
  readonly grant: BookFallbackGrant | undefined
}

export interface ReviewFallbackApprovalsDependencies {
  readonly jobs: JobRepository
  readonly approvals: FallbackApprovalRepository
  /** Shared with completed-output consumers; defaults by approval-repository identity. */
  readonly catalogAccess?: ApprovalCatalogAccess | undefined
  /** Injected so a decision time is reproducible in tests; defaults to the wall clock. */
  readonly now?: (() => Date) | undefined
}

export interface ReconcileFallbackApprovalsRequest {
  readonly book: Book
}

export interface FallbackApprovalDecisionRequest {
  readonly jobId: string
  readonly segmentId: string
  /** Who is deciding. Required — an approval with no actor is not evidence of a human decision. */
  readonly decidedBy: string
}

export interface BookFallbackGrantRequest {
  readonly jobId: string
  readonly decidedBy: string
}

/** Raised when a review decision is attempted while a render owns the job. */
export class RenderInProgressError extends DomainError {
  override readonly name = 'RenderInProgressError'
  readonly jobId: string

  constructor(jobId: string) {
    super(
      `Audiobook job ${jobId} is rendering; a fallback decision cannot change under an active render`,
    )
    this.jobId = jobId
  }
}

/**
 * The review context. Owns creating, listing, withdrawing and book-wide granting of the per-segment
 * fallback decisions `QwenApplicationSpeechEngine` requires, and the consequence of changing one: a
 * completed job goes back to awaiting review so its dependent audio is re-derived.
 *
 * **Every approval in the system originates here.** `reconcile` can only materialize records from a
 * grant that a human already issued through `grantBookFallback`; it has no policy parameter and no
 * default, so no generation run and no composition wiring can cause an approval to exist.
 */
export class ReviewFallbackApprovals {
  private readonly jobs: JobRepository
  private readonly approvals: FallbackApprovalRepository
  private readonly catalogAccess: ApprovalCatalogAccess
  private readonly now: () => Date

  constructor(dependencies: ReviewFallbackApprovalsDependencies) {
    this.jobs = dependencies.jobs
    this.approvals = dependencies.approvals
    this.catalogAccess =
      dependencies.catalogAccess ?? approvalCatalogAccessFor(dependencies.approvals)
    this.now = dependencies.now ?? ((): Date => new Date())
  }

  /**
   * Brings the persisted catalog in line with the approved script and reports what still needs a
   * human. Idempotent: a decision that still describes its segment is left byte-for-byte alone, so
   * re-running generation on an unchanged book restales nothing.
   *
   * Records are created **only** for segments a book-wide grant covers and that the human has not
   * explicitly excluded. With no grant, every undecided fallback segment comes back pending.
   */
  async reconcile(
    request: ReconcileFallbackApprovalsRequest,
  ): Promise<FallbackApprovalReconciliation> {
    return this.catalogAccess.runExclusive(request.book.id, () => this.reconcileUnlocked(request))
  }

  private async reconcileUnlocked(
    request: ReconcileFallbackApprovalsRequest,
  ): Promise<FallbackApprovalReconciliation> {
    const subjects = collectFallbackSubjects(request.book)
    const catalog = await this.approvals.readCatalog(request.book.id)
    const live = new Map(catalog.approvals.map((record) => [record.segmentId, record]))
    const excluded = new Set(catalog.exclusions.map((exclusion) => exclusion.segmentId))
    const excludedBy = new Map(
      catalog.exclusions.map((exclusion) => [exclusion.segmentId, exclusion.decidedBy]),
    )

    const approved: PersistedFallbackApproval[] = []
    const created: PersistedFallbackApproval[] = []
    const unchanged: PersistedFallbackApproval[] = []
    const invalidated: PersistedFallbackApproval[] = []
    const pending: PendingFallbackApproval[] = []
    const subjectIds = new Set(subjects.map((subject) => subject.segment.id))

    // Decisions whose segment no longer falls back at all — a re-direction resolved the speaker, or
    // the cast gained a voice. Removed so the catalog can never authorize a segment nobody reviewed.
    for (const [segmentId, record] of live) {
      if (subjectIds.has(segmentId)) continue
      await this.approvals.revoke(request.book.id, segmentId, {
        reason: 'no-longer-describes-segment',
      })
      invalidated.push(record)
      live.delete(segmentId)
    }

    for (const subject of subjects) {
      const existing = live.get(subject.segment.id)
      if (existing !== undefined && approvalStillDescribes(existing, subject)) {
        approved.push(existing)
        unchanged.push(existing)
        continue
      }
      if (existing !== undefined) {
        // The decision was about a different speaker, reason, profile or line. PLAN.md:132 makes
        // that an invalidation, not something to silently carry forward.
        await this.approvals.revoke(request.book.id, subject.segment.id, {
          reason: 'no-longer-describes-segment',
        })
        invalidated.push(existing)
      }
      // An explicit human withdrawal outranks any book-wide grant. Without this the grant would
      // silently re-create the approval on the next run and revocation would mean nothing.
      if (excluded.has(subject.segment.id)) {
        pending.push(
          pendingFrom(subject, {
            decision: 'excluded',
            decidedBy: excludedBy.get(subject.segment.id) ?? null,
          }),
        )
        continue
      }
      if (catalog.grant === undefined) {
        pending.push(pendingFrom(subject))
        continue
      }
      const record = createFallbackApprovalRecord({
        ...this.decisionFor(subject, request.book.id, catalog.grant.decidedBy),
        grantId: catalog.grant.grantId,
      })
      await this.approvals.save(record)
      approved.push(record)
      created.push(record)
    }

    return Object.freeze({
      approved: Object.freeze(approved),
      created: Object.freeze(created),
      unchanged: Object.freeze(unchanged),
      invalidated: Object.freeze(invalidated),
      pending: Object.freeze(pending),
      grant: catalog.grant,
    })
  }

  /**
   * Every unresolved speaker in the job's approved script, decided or not, for the review UI. The
   * excerpt is story text: see `PendingFallbackApproval.sourceTextExcerpt`.
   */
  async list(jobId: string): Promise<readonly PendingFallbackApproval[]> {
    const { book } = await this.load(jobId)
    const catalog = await this.approvals.readCatalog(book.id)
    const live = new Map(catalog.approvals.map((record) => [record.segmentId, record]))
    const exclusions = new Map(
      catalog.exclusions.map((exclusion) => [exclusion.segmentId, exclusion.decidedBy]),
    )
    return Object.freeze(
      collectFallbackSubjects(book).map((subject) => {
        const existing = live.get(subject.segment.id)
        if (existing !== undefined && approvalStillDescribes(existing, subject)) {
          return pendingFrom(subject, {
            decision: 'approved',
            approvalId: existing.approvalId,
            decidedBy: existing.decidedBy,
          })
        }
        const withdrawnBy = exclusions.get(subject.segment.id)
        if (withdrawnBy !== undefined) {
          return pendingFrom(subject, { decision: 'excluded', decidedBy: withdrawnBy })
        }
        return pendingFrom(subject)
      }),
    )
  }

  /** The live book-wide grant for this job's book, if a human has issued one. */
  async findGrant(jobId: string): Promise<BookFallbackGrant | undefined> {
    const { book } = await this.load(jobId)
    return (await this.approvals.readCatalog(book.id)).grant
  }

  /**
   * The M1 book-wide decision: authorize the fallback voice for every unresolved speaker in this
   * book. One explicit human act, recorded durably with its actor, that still produces one record
   * per segment — so revoking one speaker's approval later invalidates only that speaker's audio.
   *
   * Segments the human has already excluded are **not** re-approved by a grant.
   */
  async grantBookFallback(
    request: BookFallbackGrantRequest,
  ): Promise<FallbackApprovalReconciliation> {
    const { job, book } = await this.load(request.jobId)
    return this.catalogAccess.runExclusive(book.id, async () => {
      this.assertNoRenderOwns(job)
      await this.reopenIfCompleted(job)
      await this.approvals.saveBookGrant(
        createBookFallbackGrant({
          bookId: book.id,
          decidedBy: request.decidedBy,
          decidedAt: this.decidedAt(),
        }),
      )
      const reconciliation = await this.reconcileUnlocked({ book })
      await this.reopenIfCompletedSince(request.jobId)
      return reconciliation
    })
  }

  /** Withdraws the book-wide grant. Records already written stay; nothing new is derived from it. */
  async revokeBookFallback(request: BookFallbackGrantRequest): Promise<boolean> {
    const { job, book } = await this.load(request.jobId)
    return this.catalogAccess.runExclusive(book.id, async () => {
      this.assertNoRenderOwns(job)
      await this.reopenIfCompleted(job)
      const removed = await this.approvals.revokeBookGrant(book.id)
      await this.reopenIfCompletedSince(request.jobId)
      return removed
    })
  }

  /** Records one human decision, clearing any earlier withdrawal of the same segment. */
  async approve(request: FallbackApprovalDecisionRequest): Promise<PersistedFallbackApproval> {
    const { job, book } = await this.load(request.jobId)
    return this.catalogAccess.runExclusive(book.id, async () => {
      const subject = this.subjectFor(book, request.segmentId)
      this.assertNoRenderOwns(job)
      // Reopened BEFORE the decision is written, so the unsafe failure direction is impossible: if
      // the approval write then fails, the job is merely awaiting review with an unchanged decision.
      await this.reopenIfCompleted(job)
      const record = createFallbackApprovalRecord({
        ...this.decisionFor(subject, book.id, request.decidedBy),
        grantId: null,
      })
      await this.approvals.save(record)
      await this.reopenIfCompletedSince(request.jobId)
      return record
    })
  }

  /**
   * Withdraws one decision. The segment's cached audio becomes unreachable, because its content
   * address includes the approval, and rendering it again is refused until it is decided afresh.
   * Recorded as a durable exclusion, so a book-wide grant cannot re-create it.
   */
  async revoke(request: FallbackApprovalDecisionRequest): Promise<boolean> {
    const { job, book } = await this.load(request.jobId)
    return this.catalogAccess.runExclusive(book.id, async () => {
      // Proves the segment exists and does fall back, so a typo cannot look like a successful
      // revocation of a segment that was never gated.
      this.subjectFor(book, request.segmentId)
      this.assertNoRenderOwns(job)
      await this.reopenIfCompleted(job)
      const removed = await this.approvals.revoke(book.id, request.segmentId, {
        reason: 'human-withdrawal',
        decidedBy: request.decidedBy,
        decidedAt: this.decidedAt(),
      })
      await this.reopenIfCompletedSince(request.jobId)
      return removed
    })
  }

  private async load(jobId: string): Promise<{ job: AudiobookJob; book: Book }> {
    const job = await this.jobs.findJob(jobId)
    if (job === undefined) throw new DomainError(`Audiobook job ${jobId} does not exist`)
    if (job.bookId === null) throw new DomainError(`Audiobook job ${jobId} has no directed book`)
    const book = await this.jobs.findBook(job.bookId)
    if (book === undefined) {
      throw new DomainError(`Approved script for book ${job.bookId} is not persisted`)
    }
    return { job, book }
  }

  /**
   * A running job is owned by a render that has already captured its catalog. Letting a decision
   * land now would leave the render finishing segments under a withdrawn approval.
   */
  private assertNoRenderOwns(job: AudiobookJob): void {
    if (job.state === 'running') throw new RenderInProgressError(job.id)
  }

  private subjectFor(book: Book, segmentId: string): FallbackApprovalSubject {
    const subject = collectFallbackSubjects(book).find(
      (candidate) => candidate.segment.id === segmentId,
    )
    if (subject === undefined) {
      throw new DomainError(`Segment ${segmentId} does not need a fallback approval`)
    }
    return subject
  }

  private decisionFor(subject: FallbackApprovalSubject, bookId: string, decidedBy: string) {
    return {
      bookId,
      segmentId: subject.segment.id,
      speakerId: subject.speakerId,
      fallbackReason: subject.fallbackReason,
      voiceProfileId: subject.voiceProfileId,
      sourceTextSha256: subject.sourceTextSha256,
      decidedAt: this.decidedAt(),
      decidedBy,
    }
  }

  private async reopenIfCompleted(job: AudiobookJob): Promise<void> {
    if (job.state !== 'completed') return
    job.reopenForReview()
    await this.jobs.saveJob(job)
  }

  /**
   * Re-reads the job **after** the decision was written and reopens it if it has completed in the
   * meantime.
   *
   * The pre-write reopen above acts on the job as it was when this operation started, so a render
   * that completed while the operation was in flight would leave a published output that the decision
   * has since invalidated — the race round 2 narrowed but did not close. This is the immediate half of
   * the fix; the durable half is the catalog revision recorded with the output, which makes such an
   * output detectably stale even if this reopen loses the race too.
   */
  private async reopenIfCompletedSince(jobId: string): Promise<void> {
    const latest = await this.jobs.findJob(jobId)
    if (latest === undefined || latest.state !== 'completed') return
    latest.reopenForReview()
    await this.jobs.saveJob(latest)
  }

  private decidedAt(): string {
    const instant = this.now()
    if (Number.isNaN(instant.getTime())) throw new DomainError('Decision clock returned no time')
    return instant.toISOString()
  }
}

function pendingFrom(
  subject: FallbackApprovalSubject,
  decided: {
    readonly decision?: 'approved' | 'pending' | 'excluded'
    readonly approvalId?: string | null
    readonly decidedBy?: string | null
  } = {},
): PendingFallbackApproval {
  return Object.freeze({
    segmentId: subject.segment.id,
    chapterId: subject.chapterId,
    chapterTitle: subject.chapterTitle,
    speakerId: subject.speakerId,
    fallbackReason: subject.fallbackReason,
    proposedVoiceProfileId: subject.voiceProfileId,
    sourceTextExcerpt: fallbackApprovalExcerpt(subject.segment.sourceText),
    decision: decided.decision ?? 'pending',
    approvalId: decided.approvalId ?? null,
    decidedBy: decided.decidedBy ?? null,
  })
}
