import type { AudiobookJob, AudiobookOutput } from '@light-novel-audiobook/domain'
import type { FallbackApprovalRepository } from './ports.js'

export type CompletedOutputDenial =
  /** The job has not produced an output, so there is nothing to expose. */
  | 'not-completed'
  /**
   * A fallback-voice decision changed after this output was assembled. The audio was authorized by a
   * catalog that no longer stands, so the file must not be served.
   */
  | 'approval-catalog-moved'

export type CompletedOutputStatus =
  | {
      readonly exposable: true
      readonly output: AudiobookOutput
      readonly catalogRevision: number
    }
  | { readonly exposable: false; readonly denial: CompletedOutputDenial }

/**
 * **The one authority on whether a completed audiobook may be exposed.** Every reader of a stored
 * output — job projection, chapter listings, and both file-open paths — must go through this.
 *
 * Round 3 recorded the approval catalog revision alongside the output, which made a revoked
 * audiobook *detectable*, and then only the render path looked. Round 3's own review streamed
 * 101,324 bytes of a revoked M4B through the download route because the web boundary never compared
 * the revision. Detectability that one consumer checks is not a gate.
 *
 * It is deliberately a **recomputed read**, not a stored flag and not a consequence of the reopen
 * that follows a revocation. That is what makes the denial durable: if the post-revocation reopen
 * fails, or is interrupted, or races a render's commit, the very next read still compares the
 * recorded revision against a live catalog and still refuses. Nothing has to have succeeded earlier
 * for the file to be denied now.
 *
 * Callers may reopen the job on a `'approval-catalog-moved'` denial so the UI agrees with reality,
 * but they must not make the denial conditional on that reopen succeeding.
 */
export const inspectCompletedOutput = async (
  job: AudiobookJob,
  approvals: FallbackApprovalRepository,
): Promise<CompletedOutputStatus> => {
  if (job.state !== 'completed' || job.output === null || job.bookId === null) {
    return Object.freeze({ exposable: false as const, denial: 'not-completed' as const })
  }
  const { revision } = await approvals.readCatalog(job.bookId)
  if (job.catalogRevision !== revision) {
    return Object.freeze({
      exposable: false as const,
      denial: 'approval-catalog-moved' as const,
    })
  }
  return Object.freeze({
    exposable: true as const,
    output: job.output,
    catalogRevision: revision,
  })
}
