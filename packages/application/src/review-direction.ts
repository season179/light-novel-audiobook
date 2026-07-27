import { type AudiobookJob, type Book, DomainError } from '@light-novel-audiobook/domain'
import {
  createDirectionApprovalRecord,
  createDirectionScriptSha256,
  type PersistedDirectionApproval,
} from './direction-approval.js'
import type { DirectionApprovalRepository, JobRepository } from './ports.js'
import type { ReviewerIdentity } from './reviewer-identity.js'

export interface ReviewDirectionDependencies {
  readonly jobs: JobRepository
  readonly approvals: DirectionApprovalRepository
  /** Injected for reproducible tests; production uses the wall clock for the decision instant. */
  readonly now?: (() => Date) | undefined
}

export interface ConfirmDirectionRequest {
  readonly jobId: string
  /** Canonically resolved from LNA_REVIEWER or the operating-system account. */
  readonly decidedBy: ReviewerIdentity
}

/** Application operation for confirming and finding the exact currently persisted directed script. */
export class ReviewDirection {
  private readonly jobs: JobRepository
  private readonly approvals: DirectionApprovalRepository
  private readonly now: () => Date

  constructor(dependencies: ReviewDirectionDependencies) {
    this.jobs = dependencies.jobs
    this.approvals = dependencies.approvals
    this.now = dependencies.now ?? (() => new Date())
  }

  async confirm(request: ConfirmDirectionRequest): Promise<PersistedDirectionApproval> {
    const { job, book } = await this.load(request.jobId)
    if (job.state !== 'awaiting_review') {
      throw new DomainError(`Audiobook job ${job.id} is not awaiting direction review`)
    }
    const instant = this.now()
    if (Number.isNaN(instant.getTime())) throw new DomainError('Decision clock returned no time')
    const approval = createDirectionApprovalRecord({
      jobId: job.id,
      bookId: book.id,
      scriptSha256: createDirectionScriptSha256(book),
      decidedBy: request.decidedBy,
      decidedAt: instant.toISOString(),
    })
    await this.approvals.saveDirectionApproval(approval)
    return approval
  }

  /** Returns nothing as soon as any covered field or ordering in the persisted script changes. */
  async findCurrent(jobId: string): Promise<PersistedDirectionApproval | undefined> {
    const { job, book } = await this.load(jobId)
    return this.approvals.findDirectionApproval({
      jobId: job.id,
      bookId: book.id,
      scriptSha256: createDirectionScriptSha256(book),
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
}
