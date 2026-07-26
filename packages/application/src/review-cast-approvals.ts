import { DomainError } from '@light-novel-audiobook/domain'
import {
  type CastProposal,
  createCastApprovalRecord,
  type PersistedCastApproval,
  sharedVoiceMaterialGroups,
} from './cast-approval.js'
import type { CastApprovalRepository } from './ports.js'

export interface ReviewCastApprovalsDependencies {
  readonly approvals: CastApprovalRepository
  /** Character-capable IDs from the pinned, listening-evidence-backed production inventory. */
  readonly allowedMaterialProfileIds: readonly string[]
  readonly now?: (() => Date) | undefined
}

export interface ApproveCastRequest {
  readonly proposal: CastProposal
  readonly decidedBy: string
}

/** Human review use case for a model-proposed roster and character-to-material mapping. */
export class ReviewCastApprovals {
  private readonly approvals: CastApprovalRepository
  private readonly allowedMaterialProfileIds: ReadonlySet<string>
  private readonly now: () => Date

  constructor(dependencies: ReviewCastApprovalsDependencies) {
    if (
      dependencies.allowedMaterialProfileIds.length === 0 ||
      new Set(dependencies.allowedMaterialProfileIds).size !==
        dependencies.allowedMaterialProfileIds.length
    ) {
      throw new DomainError('Cast review requires a distinct approved voice-material inventory')
    }
    this.approvals = dependencies.approvals
    this.allowedMaterialProfileIds = new Set(dependencies.allowedMaterialProfileIds)
    this.now = dependencies.now ?? (() => new Date())
  }

  /**
   * This method is the only application operation that creates a cast approval. The proposal has no
   * actor field, and callers must supply the server-resolved reviewer separately.
   */
  async approve(request: ApproveCastRequest): Promise<PersistedCastApproval> {
    for (const assignment of request.proposal.assignments) {
      if (!this.allowedMaterialProfileIds.has(assignment.materialProfileId)) {
        throw new DomainError(
          `Cast material ${assignment.materialProfileId} is not in the approved production inventory`,
        )
      }
    }
    // Derive once before the write so a malformed sharing declaration cannot become a decision.
    sharedVoiceMaterialGroups(request.proposal.assignments)
    const instant = this.now()
    if (Number.isNaN(instant.getTime())) throw new DomainError('Decision clock returned no time')
    const approval = createCastApprovalRecord({
      ...request.proposal,
      decidedBy: request.decidedBy,
      decidedAt: instant.toISOString(),
    })
    await this.approvals.saveCastApproval(approval)
    return approval
  }

  async findForEpub(epubSha256: string): Promise<PersistedCastApproval | undefined> {
    return this.approvals.findCastApproval(epubSha256)
  }
}
