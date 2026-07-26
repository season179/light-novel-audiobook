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
  readonly decision: 'pending' | 'excluded'
  readonly decidedBy: string | null
}

export interface FallbackReviewApprovalNotice {
  readonly actor: string
  readonly jobId: string
  readonly decision:
    | 'approve one homogeneous fallback decision group for every listed pending segment'
    | 'approve the fallback voice for the listed segment'
  readonly items: readonly FallbackReviewItem[]
}

export interface ListFallbackReviewReport {
  readonly action: 'list'
  readonly jobId: string
  /** All decisions still requiring review, including explicit withdrawals. */
  readonly pendingCount: number
  readonly excludedCount: number
  readonly items: readonly FallbackReviewItem[]
}

export interface ApproveFallbackReviewReport {
  readonly action: 'approve'
  readonly scope: 'book' | 'segment'
  readonly jobId: string
  readonly actor: string
  readonly approvedCount: number
  readonly remainingReviewCount: number
  readonly grantId: string | null
  readonly approvalId: string | null
  readonly items: readonly FallbackReviewItem[]
}

export type FallbackReviewReport = ListFallbackReviewReport | ApproveFallbackReviewReport

export interface FallbackReviewCommandOptions {
  readonly action: 'list' | 'approve'
  readonly workspaceRoot: string
  readonly jobId: string
  /** With approve, makes an individual decision and clears any withdrawal for this segment. */
  readonly segmentId?: string | undefined
  /** Defaults to the same environment/OS-account resolver as the local web review path. */
  readonly resolveReviewer?: (() => string) | undefined
  /** Called before the durable grant or segment approval is written. */
  readonly announceApproval?: ((notice: FallbackReviewApprovalNotice) => void) | undefined
}

/**
 * Lists or explicitly approves fallback decisions in the driver's real SQLite workspace.
 *
 * This is intentionally separate from generation. No rendering command calls it. Every approval
 * requires an attributed actor and either a pending bulk group or one listed segment decision.
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
    const reviewRequired = listed.filter((item) => item.decision !== 'approved')
    const pending = listed.filter((item) => item.decision === 'pending')
    const excluded = listed.filter((item) => item.decision === 'excluded')

    if (options.action === 'list') {
      return Object.freeze({
        action: 'list',
        jobId,
        pendingCount: reviewRequired.length,
        excludedCount: excluded.length,
        items: Object.freeze(reviewRequired.map(reviewItem)),
      })
    }

    if (actor === undefined) throw new DomainError('Fallback approval requires a reviewer')
    const requestedSegmentId = options.segmentId?.trim()
    if (options.segmentId !== undefined && requestedSegmentId?.length === 0) {
      throw new DomainError('Fallback segment approval requires a segment ID')
    }
    if (requestedSegmentId !== undefined) {
      const requested = reviewRequired.find((item) => item.segmentId === requestedSegmentId)
      if (requested === undefined) {
        throw new DomainError(
          `Segment ${requestedSegmentId} does not have a pending fallback decision for audiobook job ${jobId}`,
        )
      }
      const items = Object.freeze([reviewItem(requested)])
      options.announceApproval?.(
        Object.freeze({
          actor,
          jobId,
          decision: 'approve the fallback voice for the listed segment',
          items,
        }),
      )
      const approval = await review.approve({
        jobId,
        segmentId: requestedSegmentId,
        decidedBy: actor,
      })
      if (approval.decidedBy !== actor || approval.segmentId !== requestedSegmentId) {
        throw new DomainError(
          `Audiobook job ${jobId} did not persist the attributed fallback approval`,
        )
      }
      const remaining = (await review.list(jobId)).filter((item) => item.decision !== 'approved')
      return Object.freeze({
        action: 'approve',
        scope: 'segment',
        jobId,
        actor,
        approvedCount: 1,
        remainingReviewCount: remaining.length,
        grantId: null,
        approvalId: approval.approvalId,
        items,
      })
    }

    const items = Object.freeze(pending.map(reviewItem))
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
    const grant = reconciliation.grant
    if (grant === undefined || grant.decidedBy !== actor) {
      throw new DomainError(`Audiobook job ${jobId} did not persist the attributed fallback grant`)
    }
    return Object.freeze({
      action: 'approve',
      scope: 'book',
      jobId,
      actor,
      approvedCount: reconciliation.created.length,
      remainingReviewCount: reconciliation.pending.length,
      grantId: grant.grantId,
      approvalId: null,
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
    decision: item.decision === 'excluded' ? 'excluded' : 'pending',
    decidedBy: item.decidedBy,
  })
}

export function decisionGroupKey(
  item: Pick<FallbackReviewItem, 'speakerId' | 'fallbackReason' | 'proposedVoiceProfileId'>,
): string {
  return JSON.stringify([item.speakerId, item.fallbackReason, item.proposedVoiceProfileId])
}
