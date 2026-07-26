import { AsyncLocalStorage } from 'node:async_hooks'
import {
  type AudiobookJob,
  type AudiobookOutput,
  OutputVersion,
} from '@light-novel-audiobook/domain'
import type { FallbackApprovalRepository, JobRepository } from './ports.js'

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

export class ApprovalCatalogReentryError extends Error {
  override readonly name = 'ApprovalCatalogReentryError'
  readonly bookId: string

  constructor(bookId: string, heldBookId: string) {
    super(
      bookId === heldBookId
        ? `Approval catalog callback for ${bookId} must not re-enter output authorization or approval mutation for the same book`
        : `Approval catalog callback holding ${heldBookId} must not nest catalog access for ${bookId}`,
    )
    this.bookId = bookId
  }
}

interface CatalogOwnership {
  readonly bookId: string
  readonly parent: CatalogOwnership | undefined
  active: boolean
}

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
  private readonly ownership = new AsyncLocalStorage<CatalogOwnership>()

  async runExclusive<T>(bookId: string, operation: () => T | Promise<T>): Promise<T> {
    if (bookId.trim().length === 0) throw new Error('Approval catalog access requires a book ID')
    let ancestor = this.ownership.getStore()
    while (ancestor !== undefined && !ancestor.active) ancestor = ancestor.parent
    if (ancestor !== undefined) {
      throw new ApprovalCatalogReentryError(bookId, ancestor.bookId)
    }
    const previous = this.tails.get(bookId) ?? Promise.resolve()
    let release: (() => void) | undefined
    const turn = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => turn)
    this.tails.set(bookId, tail)
    await previous
    const ownership: CatalogOwnership = {
      bookId,
      parent: this.ownership.getStore(),
      active: true,
    }
    try {
      return await this.ownership.run(ownership, operation)
    } finally {
      ownership.active = false
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

/*
 * Runtime capability minted only in this module after a live catalog read. The class is deliberately
 * not exported, its constructor is private, and its payload is a JavaScript #private field. A stored
 * revision number cannot fabricate it, even through an `as unknown` type escape.
 */
class LiveCatalogRead {
  readonly #output: AudiobookOutput

  private constructor(output: AudiobookOutput) {
    this.#output = output
  }

  static mint(
    job: AudiobookJob,
    liveRevision: number,
    persistedOutput: AudiobookOutput | undefined,
  ): LiveCatalogRead | undefined {
    if (
      job.state !== 'completed' ||
      job.catalogRevision !== liveRevision ||
      persistedOutput === undefined
    ) {
      return undefined
    }
    return new LiveCatalogRead(
      Object.freeze({
        version: new OutputVersion(persistedOutput.version.value),
        m4bPath: persistedOutput.m4bPath,
        chapters: Object.freeze(
          persistedOutput.chapters.map((chapter) => Object.freeze({ ...chapter })),
        ),
      }),
    )
  }

  consume(): AudiobookOutput {
    return this.#output
  }
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
  private readonly jobs: JobRepository
  readonly catalogAccess: ApprovalCatalogAccess

  constructor(
    approvals: FallbackApprovalRepository,
    jobs: JobRepository,
    catalogAccess: ApprovalCatalogAccess = approvalCatalogAccessFor(approvals),
  ) {
    this.approvals = approvals
    this.jobs = jobs
    this.catalogAccess = catalogAccess
  }

  /**
   * @param consume Runs while this book's catalog section is held. It must not call this authority
   * again or acquire any approval catalog; all nested catalog access throws
   * `ApprovalCatalogReentryError` before it can wait behind itself or form a cross-book cycle.
   */
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
    if (job.catalogRevision !== preliminary.revision) {
      return Object.freeze({
        exposable: false as const,
        denial: 'approval-catalog-moved' as const,
      })
    }
    return this.catalogAccess.runExclusive(bookId, async () => {
      const { revision } = await this.approvals.readCatalog(bookId)
      const persistedOutput = await this.jobs.findCompletedOutput(job.id)
      const proof = LiveCatalogRead.mint(job, revision, persistedOutput)
      if (proof === undefined) {
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
        value: await consume(proof.consume()),
        catalogRevision: revision,
      })
    })
  }
}
