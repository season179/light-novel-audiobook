import {
  RenderInProgressError,
  type ReviewFallbackApprovals,
} from '@light-novel-audiobook/application'
import { WebApiError } from './errors.js'
import type { GenerationRunner } from './generation-runner.js'
import type { ReviewerIdentity } from './reviewer-identity.js'

export interface FallbackSelectionReviewDependencies {
  readonly review: ReviewFallbackApprovals
  readonly runner: GenerationRunner
  readonly reviewer: ReviewerIdentity
}

/**
 * The exact-set review decision (issue #96 step 4): the user ticks the N of M pending lines they
 * accept and makes one decision over that exact set; the rest keep blocking.
 *
 * This lives outside `AudiobookWebApi` because the render-gate half of #96 (step 3) owns that file
 * while this lands in parallel. It is deliberately tiny — the rule (reject any ID not currently on
 * offer) lives in `ReviewFallbackApprovals.grantBookFallback`, and the actor still comes only from
 * server configuration, never from the request. The render-ownership guard mirrors
 * `AudiobookWebApi.runReviewDecision` exactly, with the same user-facing wording.
 */
export class FallbackSelectionReview {
  private readonly review: ReviewFallbackApprovals
  private readonly runner: GenerationRunner
  private readonly reviewer: ReviewerIdentity

  constructor(dependencies: FallbackSelectionReviewDependencies) {
    this.review = dependencies.review
    this.runner = dependencies.runner
    this.reviewer = dependencies.reviewer
  }

  /**
   * Records one grant over exactly the listed pending segments. The whole set is rejected — nothing
   * approved — when any ID is not awaiting a decision when the write lands, because the user's
   * mental model is "I approved these exact N" and a silent subset would be a lie.
   */
  async approveSelected(input: {
    readonly jobId: string
    readonly segmentIds: readonly string[]
  }): Promise<void> {
    if (this.runner.isActive(input.jobId)) {
      throw new WebApiError(
        'generation_rejected',
        'This audiobook is rendering. Wait for it to finish before changing a fallback-voice decision.',
      )
    }
    try {
      await this.review.grantBookFallback({
        jobId: input.jobId,
        decidedBy: this.reviewer,
        segmentIds: input.segmentIds,
      })
    } catch (error) {
      if (error instanceof RenderInProgressError) {
        throw new WebApiError(
          'generation_rejected',
          'This audiobook is rendering. Wait for it to finish before changing a fallback-voice decision.',
        )
      }
      throw error
    }
  }
}
