import type {
  BookFallbackGrant,
  FallbackApprovalCatalog,
  FallbackApprovalExclusion,
  FallbackApprovalRepository,
  FallbackRevocationReason,
  PersistedFallbackApproval,
} from '../../src/index.js'

/**
 * In-memory `FallbackApprovalRepository` for application tests.
 *
 * Honours the two rules the port requires of a real adapter, because the use cases depend on them:
 * every mutation bumps `revision`, and `readCatalog` returns records and revision together. A fake
 * that skipped the counter would let the render-barrier tests pass while proving nothing.
 */
export class InMemoryFallbackApprovalRepository implements FallbackApprovalRepository {
  readonly approvals = new Map<string, PersistedFallbackApproval>()
  readonly exclusions = new Map<string, FallbackApprovalExclusion>()
  readonly grants = new Map<string, BookFallbackGrant>()
  readonly revocations: { segmentId: string; reason: FallbackRevocationReason }[] = []
  saved: string[] = []
  private revisions = new Map<string, number>()

  async readCatalog(bookId: string): Promise<FallbackApprovalCatalog> {
    return {
      revision: this.revisions.get(bookId) ?? 0,
      approvals: [...this.approvals.values()]
        .filter((record) => record.bookId === bookId)
        .sort((left, right) => (left.segmentId < right.segmentId ? -1 : 1)),
      exclusions: [...this.exclusions.values()]
        .filter((exclusion) => exclusion.bookId === bookId)
        .sort((left, right) => (left.segmentId < right.segmentId ? -1 : 1)),
      grant: this.grants.get(bookId),
    }
  }

  async save(record: PersistedFallbackApproval): Promise<void> {
    this.saved.push(record.segmentId)
    this.approvals.set(this.key(record.bookId, record.segmentId), record)
    this.exclusions.delete(this.key(record.bookId, record.segmentId))
    this.bump(record.bookId)
  }

  async revoke(
    bookId: string,
    segmentId: string,
    reason: FallbackRevocationReason,
    actor: { readonly decidedBy: string; readonly decidedAt: string },
  ): Promise<boolean> {
    this.revocations.push({ segmentId, reason })
    const removed = this.approvals.delete(this.key(bookId, segmentId))
    if (reason === 'human-withdrawal') {
      this.exclusions.set(this.key(bookId, segmentId), {
        bookId,
        segmentId,
        decidedBy: actor.decidedBy,
        decidedAt: actor.decidedAt,
      })
    }
    this.bump(bookId)
    return removed
  }

  async saveBookGrant(grant: BookFallbackGrant): Promise<void> {
    this.grants.set(grant.bookId, grant)
    this.bump(grant.bookId)
  }

  async revokeBookGrant(bookId: string): Promise<boolean> {
    const removed = this.grants.delete(bookId)
    this.bump(bookId)
    return removed
  }

  /** Test seam: simulates another actor's decision landing while a render is in flight. */
  bumpRevisionOutOfBand(bookId: string): void {
    this.bump(bookId)
  }

  private bump(bookId: string): void {
    this.revisions.set(bookId, (this.revisions.get(bookId) ?? 0) + 1)
  }

  private key(bookId: string, segmentId: string): string {
    return `${bookId}:${segmentId}`
  }
}
