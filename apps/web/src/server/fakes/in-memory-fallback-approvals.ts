import type {
  BookFallbackGrant,
  FallbackApprovalCatalog,
  FallbackApprovalExclusion,
  FallbackApprovalRepository,
  FallbackRevocation,
  PersistedFallbackApproval,
} from '@light-novel-audiobook/application'

const key = (bookId: string, segmentId: string): string => `${bookId}::${segmentId}`

/**
 * FAKE review ledger, replaced by `SqliteFallbackApprovalRepository` at #21.
 *
 * It honours the two rules the port requires of any adapter, because `RenderAudiobook` depends on
 * them: every mutation bumps the book's catalog revision, and `readCatalog` returns records and
 * revision together. A fake that skipped the counter would silently disable the render barrier that
 * stops a withdrawn approval from completing.
 *
 * Loses everything on restart, like the rest of these fakes. That matters more here than elsewhere —
 * a lost approval means a book with unresolved speakers stops for review again rather than rendering
 * something nobody authorized, which is the safe direction.
 */
export class InMemoryFallbackApprovalRepository implements FallbackApprovalRepository {
  private readonly approvals = new Map<string, PersistedFallbackApproval>()
  private readonly exclusions = new Map<string, FallbackApprovalExclusion>()
  private readonly grants = new Map<string, BookFallbackGrant>()
  private readonly revisions = new Map<string, number>()

  async readCatalog(bookId: string): Promise<FallbackApprovalCatalog> {
    return Object.freeze({
      revision: this.revisions.get(bookId) ?? 0,
      approvals: Object.freeze(
        [...this.approvals.values()]
          .filter((record) => record.bookId === bookId)
          .sort((left, right) => (left.segmentId < right.segmentId ? -1 : 1)),
      ),
      exclusions: Object.freeze(
        [...this.exclusions.values()]
          .filter((exclusion) => exclusion.bookId === bookId)
          .sort((left, right) => (left.segmentId < right.segmentId ? -1 : 1)),
      ),
      grant: this.grants.get(bookId),
    })
  }

  async save(record: PersistedFallbackApproval): Promise<void> {
    this.approvals.set(key(record.bookId, record.segmentId), record)
    // Approving clears an earlier withdrawal, or a book-wide grant stays blocked for this segment.
    this.exclusions.delete(key(record.bookId, record.segmentId))
    this.bump(record.bookId)
  }

  async revoke(
    bookId: string,
    segmentId: string,
    revocation: FallbackRevocation,
  ): Promise<boolean> {
    const removed = this.approvals.delete(key(bookId, segmentId))
    if (revocation.reason === 'human-withdrawal') {
      this.exclusions.set(key(bookId, segmentId), {
        bookId,
        segmentId,
        decidedBy: revocation.decidedBy,
        decidedAt: revocation.decidedAt,
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

  private bump(bookId: string): void {
    this.revisions.set(bookId, (this.revisions.get(bookId) ?? 0) + 1)
  }
}
