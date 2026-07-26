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

export type CompletedOutputAuthorization<T> =
  | {
      readonly exposable: true
      readonly value: T
      readonly catalogRevision: number
    }
  | { readonly exposable: false; readonly denial: CompletedOutputDenial }

/**
 * A short, fair, per-book critical section shared by approval writers and completed-output readers.
 *
 * It lasts only until an output consumer has committed to its read. For a file response that means
 * the descriptor has been opened; the stream itself deliberately does not hold the section. Thus an
 * already-authorized stream may finish, while no approval mutation can commit between the final live
 * catalog check and descriptor acquisition. Mutations for one book do not block another book.
 */
export class ApprovalCatalogAccess {
  private readonly tails = new Map<string, Promise<void>>()

  async runExclusive<T>(bookId: string, operation: () => T | Promise<T>): Promise<T> {
    if (bookId.trim().length === 0) throw new Error('Approval catalog access requires a book ID')
    const previous = this.tails.get(bookId) ?? Promise.resolve()
    let release: (() => void) | undefined
    const turn = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => turn)
    this.tails.set(bookId, tail)
    await previous
    try {
      return await operation()
    } finally {
      release?.()
      if (this.tails.get(bookId) === tail) this.tails.delete(bookId)
    }
  }
}

const catalogAccessByRepository = new WeakMap<object, ApprovalCatalogAccess>()

/** Keeps separately constructed application services coordinated when they share one repository. */
export const approvalCatalogAccessFor = (
  approvals: FallbackApprovalRepository,
): ApprovalCatalogAccess => {
  const key = approvals as object
  const existing = catalogAccessByRepository.get(key)
  if (existing !== undefined) return existing
  const created = new ApprovalCatalogAccess()
  catalogAccessByRepository.set(key, created)
  return created
}

/**
 * The sole application authority for consuming a completed output.
 *
 * It intentionally never returns a raw `output` field. A caller supplies the operation that consumes
 * the output, and that operation runs inside the same short catalog critical section as the final
 * authorization. Returning a file descriptor, a result DTO, or an authorized snapshot is safe;
 * opening a path later, outside the callback, is not.
 */
export class CompletedOutputAuthority {
  private readonly approvals: FallbackApprovalRepository
  readonly catalogAccess: ApprovalCatalogAccess

  constructor(
    approvals: FallbackApprovalRepository,
    catalogAccess: ApprovalCatalogAccess = approvalCatalogAccessFor(approvals),
  ) {
    this.approvals = approvals
    this.catalogAccess = catalogAccess
  }

  async authorize<T>(
    job: AudiobookJob,
    consume: (output: AudiobookOutput) => T | Promise<T>,
  ): Promise<CompletedOutputAuthorization<T>> {
    const bookId = job.bookId
    if (job.state !== 'completed' || bookId === null) {
      return Object.freeze({ exposable: false as const, denial: 'not-completed' as const })
    }
    // This preliminary read is never an authorization: it can only reject an already-stale job.
    // The final read below is repeated while catalog writers are excluded and immediately followed
    // by consumption. If a withdrawal commits after this read returns a stale snapshot but before
    // the critical section is acquired, the final read observes it and no descriptor is opened.
    const preliminary = await this.approvals.readCatalog(bookId)
    if (job.completedOutputAtCatalogRevision(preliminary.revision) === null) {
      return Object.freeze({
        exposable: false as const,
        denial: 'approval-catalog-moved' as const,
      })
    }
    return this.catalogAccess.runExclusive(bookId, async () => {
      const { revision } = await this.approvals.readCatalog(bookId)
      const output = job.completedOutputAtCatalogRevision(revision)
      if (output === null) {
        return Object.freeze({
          exposable: false as const,
          denial:
            job.state === 'completed'
              ? ('approval-catalog-moved' as const)
              : ('not-completed' as const),
        })
      }
      return Object.freeze({
        exposable: true as const,
        value: await consume(output),
        catalogRevision: revision,
      })
    })
  }
}
