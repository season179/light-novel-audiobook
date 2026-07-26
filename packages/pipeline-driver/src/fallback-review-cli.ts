import {
  type PendingFallbackApproval,
  ReviewFallbackApprovals,
  resolveReviewerIdentity,
} from '@light-novel-audiobook/application'
import { DomainError, type FallbackReason, type SegmentKind } from '@light-novel-audiobook/domain'
import {
  layoutFor,
  migrateSchema,
  openWorkspace,
  SqliteFallbackApprovalRepository,
  SqliteJobRepository,
} from '@light-novel-audiobook/persistence'

export interface FallbackReviewItem {
  readonly segmentId: string
  readonly sourcePassageId: string
  readonly kind: SegmentKind
  /** Stable identifier only; never source prose or a display name. */
  readonly speakerId: string | null
  readonly fallbackReason: FallbackReason
  readonly speakerReason: string
  readonly proposedVoiceProfileId: string
}

export interface FallbackReviewApprovalNotice {
  readonly actor: string
  readonly jobId: string
  readonly decision: 'approve one homogeneous fallback decision group for every listed pending segment'
  readonly items: readonly FallbackReviewItem[]
}

export interface ListFallbackReviewReport {
  readonly action: 'list'
  readonly jobId: string
  readonly pendingCount: number
  readonly items: readonly FallbackReviewItem[]
}

export interface ApproveFallbackReviewReport {
  readonly action: 'approve'
  readonly jobId: string
  readonly actor: string
  readonly approvedCount: number
  readonly grantId: string
  readonly items: readonly FallbackReviewItem[]
}

export type FallbackReviewReport = ListFallbackReviewReport | ApproveFallbackReviewReport

export interface FallbackReviewCommandOptions {
  readonly action: 'list' | 'approve'
  readonly workspaceRoot: string
  readonly jobId: string
  /** Defaults to the same environment/OS-account resolver as the local web review path. */
  readonly resolveReviewer?: (() => string) | undefined
  /** Called before the durable grant is written, so CLI output states the human act first. */
  readonly announceApproval?: ((notice: FallbackReviewApprovalNotice) => void) | undefined
}

/**
 * Lists or explicitly approves fallback decisions in the driver's real SQLite workspace.
 *
 * This is intentionally separate from generation. No rendering command calls it, and the approval
 * branch cannot run without an attributed actor and at least one pending decision.
 */
export async function runFallbackReviewCommand(
  options: FallbackReviewCommandOptions,
): Promise<FallbackReviewReport> {
  const jobId = options.jobId.trim()
  if (jobId.length === 0) throw new DomainError('Fallback review requires a job ID')
  if (options.workspaceRoot.trim().length === 0) {
    throw new DomainError('Fallback review requires a workspace')
  }
  const actor =
    options.action === 'approve'
      ? (options.resolveReviewer ?? (() => resolveReviewerIdentity()))()
      : undefined

  const layout = layoutFor(options.workspaceRoot)
  const database = openWorkspace(layout)
  try {
    migrateSchema(database)
    const jobs = new SqliteJobRepository(layout, database)
    const approvals = new SqliteFallbackApprovalRepository(database)
    const review = new ReviewFallbackApprovals({ jobs, approvals })
    const listed = await review.list(jobId)
    const excluded = listed.filter((item) => item.decision === 'excluded')
    const pending = listed.filter((item) => item.decision === 'pending')
    const items = Object.freeze(pending.map(reviewItem))

    if (options.action === 'list') {
      return Object.freeze({
        action: 'list',
        jobId,
        pendingCount: items.length,
        items,
      })
    }

    if (actor === undefined) throw new DomainError('Fallback approval requires a reviewer')
    if (excluded.length > 0) {
      throw new DomainError(
        `Audiobook job ${jobId} has ${excluded.length} explicitly excluded fallback decision(s); bulk approval will not override a human withdrawal`,
      )
    }
    if (items.length === 0) {
      throw new DomainError(`Audiobook job ${jobId} has no pending fallback decisions to approve`)
    }
    if (new Set(items.map(decisionGroupKey)).size !== 1) {
      throw new DomainError(
        `Audiobook job ${jobId} has heterogeneous fallback decisions; book-wide bulk approval requires one speaker, reason and proposed voice profile`,
      )
    }
    const notice: FallbackReviewApprovalNotice = Object.freeze({
      actor,
      jobId,
      decision: 'approve one homogeneous fallback decision group for every listed pending segment',
      items,
    })
    options.announceApproval?.(notice)

    const reconciliation = await review.grantBookFallback({ jobId, decidedBy: actor })
    if (reconciliation.pending.length > 0) {
      throw new DomainError(
        `Audiobook job ${jobId} still has ${reconciliation.pending.length} excluded fallback decision(s)`,
      )
    }
    const grant = reconciliation.grant
    if (grant === undefined || grant.decidedBy !== actor) {
      throw new DomainError(`Audiobook job ${jobId} did not persist the attributed fallback grant`)
    }
    return Object.freeze({
      action: 'approve',
      jobId,
      actor,
      approvedCount: reconciliation.created.length,
      grantId: grant.grantId,
      items,
    })
  } finally {
    database.close()
  }
}

function reviewItem(item: PendingFallbackApproval): FallbackReviewItem {
  return Object.freeze({
    segmentId: item.segmentId,
    sourcePassageId: item.sourcePassageId,
    kind: item.kind,
    speakerId: item.speakerId,
    fallbackReason: item.fallbackReason,
    speakerReason: item.speakerReason,
    proposedVoiceProfileId: item.proposedVoiceProfileId,
  })
}

function decisionGroupKey(item: FallbackReviewItem): string {
  return JSON.stringify([item.speakerId, item.fallbackReason, item.proposedVoiceProfileId])
}
