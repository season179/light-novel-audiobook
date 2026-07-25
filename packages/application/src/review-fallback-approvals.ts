import { type AudiobookJob, type Book, DomainError } from '@light-novel-audiobook/domain'
import {
  approvalStillDescribes,
  collectFallbackSubjects,
  createFallbackApprovalRecord,
  type FallbackApprovalSubject,
  fallbackApprovalExcerpt,
  type PendingFallbackApproval,
  type PersistedFallbackApproval,
} from './fallback-approval.js'
import type { FallbackApprovalRepository, JobRepository } from './ports.js'

/**
 * How unresolved speakers are decided for one book.
 *
 * There are exactly two values and neither one renders an unapproved fallback segment. In
 * particular `'pre-approve-book-fallback'` is **not** an auto-approve escape hatch: it is a single
 * human decision made before generation ("use the fallback voice for any unresolved speaker in this
 * book") that is then written out as one durable per-segment record each. That is what keeps
 * revoking one speaker's approval from touching another speaker's audio, while a 2,328-passage book
 * does not stop for a click per line.
 */
export const FALLBACK_APPROVAL_POLICIES = [
  'pre-approve-book-fallback',
  'require-explicit-review',
] as const
export type FallbackApprovalPolicy = (typeof FALLBACK_APPROVAL_POLICIES)[number]

export interface FallbackApprovalReconciliation {
  /** The live catalog after reconciliation, in book order. What the speech engine is built with. */
  readonly approved: readonly PersistedFallbackApproval[]
  readonly created: readonly PersistedFallbackApproval[]
  readonly unchanged: readonly PersistedFallbackApproval[]
  /** Decisions removed because their segment or its approved line no longer matches them. */
  readonly revoked: readonly PersistedFallbackApproval[]
  /** Unresolved speakers still needing a human decision. Rendering cannot start while non-empty. */
  readonly pending: readonly PendingFallbackApproval[]
}

export interface ReviewFallbackApprovalsDependencies {
  readonly jobs: JobRepository
  readonly approvals: FallbackApprovalRepository
  /** Injected so a decision time is reproducible in tests; defaults to the wall clock. */
  readonly now?: (() => Date) | undefined
}

export interface ReconcileFallbackApprovalsRequest {
  readonly book: Book
  readonly policy: FallbackApprovalPolicy
}

export interface FallbackApprovalDecisionRequest {
  readonly jobId: string
  readonly segmentId: string
}

/**
 * The review context. Owns creating, listing, and revoking the per-segment fallback decisions that
 * `QwenApplicationSpeechEngine` requires, and the consequence of changing one: a completed job goes
 * back to awaiting review so its dependent audio is re-derived.
 */
export class ReviewFallbackApprovals {
  private readonly jobs: JobRepository
  private readonly approvals: FallbackApprovalRepository
  private readonly now: () => Date

  constructor(dependencies: ReviewFallbackApprovalsDependencies) {
    this.jobs = dependencies.jobs
    this.approvals = dependencies.approvals
    this.now = dependencies.now ?? ((): Date => new Date())
  }

  /**
   * Brings the persisted catalog in line with the approved script under the chosen policy, and
   * reports what still needs a human. Idempotent: a decision that still describes its segment is
   * left byte-for-byte alone, so re-running generation on an unchanged book restales nothing.
   */
  async reconcile(
    request: ReconcileFallbackApprovalsRequest,
  ): Promise<FallbackApprovalReconciliation> {
    if (!FALLBACK_APPROVAL_POLICIES.includes(request.policy)) {
      throw new DomainError(`Unsupported fallback approval policy: ${request.policy}`)
    }
    const subjects = collectFallbackSubjects(request.book)
    const live = new Map(
      (await this.approvals.listForBook(request.book.id)).map((record) => [
        record.segmentId,
        record,
      ]),
    )

    const approved: PersistedFallbackApproval[] = []
    const created: PersistedFallbackApproval[] = []
    const unchanged: PersistedFallbackApproval[] = []
    const revoked: PersistedFallbackApproval[] = []
    const pending: PendingFallbackApproval[] = []
    const subjectIds = new Set(subjects.map((subject) => subject.segment.id))

    // Decisions whose segment no longer falls back at all — a re-direction resolved the speaker, or
    // the cast gained a voice. Removed so the catalog can never authorize a segment nobody reviewed.
    for (const [segmentId, record] of live) {
      if (subjectIds.has(segmentId)) continue
      await this.approvals.revoke(request.book.id, segmentId)
      revoked.push(record)
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
        await this.approvals.revoke(request.book.id, subject.segment.id)
        revoked.push(existing)
      }
      if (request.policy === 'require-explicit-review') {
        pending.push(pendingFrom(subject))
        continue
      }
      const record = createFallbackApprovalRecord({
        bookId: request.book.id,
        segmentId: subject.segment.id,
        speakerId: subject.speakerId,
        fallbackReason: subject.fallbackReason,
        voiceProfileId: subject.voiceProfileId,
        sourceTextSha256: subject.sourceTextSha256,
        decidedAt: this.decidedAt(),
      })
      await this.approvals.save(record)
      approved.push(record)
      created.push(record)
    }

    return Object.freeze({
      approved: Object.freeze(approved),
      created: Object.freeze(created),
      unchanged: Object.freeze(unchanged),
      revoked: Object.freeze(revoked),
      pending: Object.freeze(pending),
    })
  }

  /**
   * Every unresolved speaker in the job's approved script, decided or not, for the review UI. The
   * excerpt is story text: see `PendingFallbackApproval.sourceTextExcerpt`.
   */
  async list(jobId: string): Promise<readonly PendingFallbackApproval[]> {
    const { book } = await this.load(jobId)
    const live = new Map(
      (await this.approvals.listForBook(book.id)).map((record) => [record.segmentId, record]),
    )
    return Object.freeze(
      collectFallbackSubjects(book).map((subject) => {
        const existing = live.get(subject.segment.id)
        const decided = existing !== undefined && approvalStillDescribes(existing, subject)
        return pendingFrom(subject, decided ? existing.approvalId : null)
      }),
    )
  }

  /** Records one human decision. A completed job returns to review so its audio is re-derived. */
  async approve(request: FallbackApprovalDecisionRequest): Promise<PersistedFallbackApproval> {
    const { job, book } = await this.load(request.jobId)
    const subject = this.subjectFor(book, request.segmentId)
    const record = createFallbackApprovalRecord({
      bookId: book.id,
      segmentId: subject.segment.id,
      speakerId: subject.speakerId,
      fallbackReason: subject.fallbackReason,
      voiceProfileId: subject.voiceProfileId,
      sourceTextSha256: subject.sourceTextSha256,
      decidedAt: this.decidedAt(),
    })
    // Replaced rather than merged: a second decision about the same segment supersedes the first,
    // and leaving the old row would keep its audio reachable.
    await this.approvals.revoke(book.id, subject.segment.id)
    await this.approvals.save(record)
    await this.reopenIfCompleted(job)
    return record
  }

  /**
   * Withdraws one decision. The segment's cached audio becomes unreachable, because its content
   * address includes the approval, and rendering it again is refused until it is decided afresh.
   */
  async revoke(request: FallbackApprovalDecisionRequest): Promise<boolean> {
    const { job, book } = await this.load(request.jobId)
    // Proves the segment exists and does fall back, so a typo cannot look like a successful
    // revocation of a segment that was never gated.
    this.subjectFor(book, request.segmentId)
    const removed = await this.approvals.revoke(book.id, request.segmentId)
    if (removed) await this.reopenIfCompleted(job)
    return removed
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

  private subjectFor(book: Book, segmentId: string): FallbackApprovalSubject {
    const subject = collectFallbackSubjects(book).find(
      (candidate) => candidate.segment.id === segmentId,
    )
    if (subject === undefined) {
      throw new DomainError(`Segment ${segmentId} does not need a fallback approval`)
    }
    return subject
  }

  private async reopenIfCompleted(job: AudiobookJob): Promise<void> {
    if (job.state !== 'completed') return
    job.reopenForReview()
    await this.jobs.saveJob(job)
  }

  private decidedAt(): string {
    const instant = this.now()
    const iso = instant.toISOString()
    if (Number.isNaN(instant.getTime())) throw new DomainError('Decision clock returned no time')
    return iso
  }
}

function pendingFrom(
  subject: FallbackApprovalSubject,
  approvalId: string | null = null,
): PendingFallbackApproval {
  return Object.freeze({
    segmentId: subject.segment.id,
    chapterId: subject.chapterId,
    chapterTitle: subject.chapterTitle,
    speakerId: subject.speakerId,
    fallbackReason: subject.fallbackReason,
    proposedVoiceProfileId: subject.voiceProfileId,
    sourceTextExcerpt: fallbackApprovalExcerpt(subject.segment.sourceText),
    decision: approvalId === null ? ('pending' as const) : ('approved' as const),
    approvalId,
  })
}
