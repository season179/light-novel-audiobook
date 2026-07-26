import type { DatabaseSync } from 'node:sqlite'
import type {
  BookFallbackGrant,
  BookFallbackGrantSubject,
  FallbackApprovalCatalog,
  FallbackApprovalExclusion,
  FallbackApprovalRepository,
  FallbackRevocation,
  PersistedFallbackApproval,
} from '@light-novel-audiobook/application'
import {
  createBookFallbackGrant,
  createFallbackApprovalExclusion,
  createFallbackApprovalRecord,
} from '@light-novel-audiobook/application'
import { DomainError } from '@light-novel-audiobook/domain'
import { withBusyRetryingTransaction } from './transaction.js'

interface ApprovalRow {
  readonly book_id: string
  readonly segment_id: string
  readonly speaker_id: string | null
  readonly fallback_reason: string
  readonly voice_profile_id: string
  readonly source_text_sha256: string
  readonly decided_at: string
  readonly decided_by: string
  readonly grant_id: string | null
  readonly approval_id: string
  readonly approval_sha256: string
}

interface ExclusionRow {
  readonly book_id: string
  readonly segment_id: string
  readonly decided_by: string
  readonly decided_at: string
}

interface GrantRow {
  readonly book_id: string
  readonly decided_by: string
  readonly decided_at: string
  readonly subjects_json: string
  readonly grant_id: string
  readonly grant_sha256: string
}

/**
 * The review context's ledger: live per-segment approvals, durable human exclusions, and the
 * book-wide grant, plus a per-book **catalog revision**.
 *
 * The revision is what makes a render safe against a concurrent decision. Every mutation here bumps
 * it inside the same transaction as the row it writes, and `readCatalog` reads records and revision
 * in one transaction, so `RenderAudiobook` can claim a catalog and later prove nothing moved. Reading
 * them separately would leave exactly the race the revision exists to close.
 */
export class SqliteFallbackApprovalRepository implements FallbackApprovalRepository {
  constructor(private readonly db: DatabaseSync) {}

  async readCatalog(bookId: string): Promise<FallbackApprovalCatalog> {
    requireBookId(bookId)
    // One transaction: a mutation cannot interleave between the revision read and the row reads, so
    // the returned revision always describes exactly the returned records.
    return withBusyRetryingTransaction(
      this.db,
      (): FallbackApprovalCatalog => {
        const revisionRow = this.db
          .prepare('SELECT revision FROM fallback_catalog_revisions WHERE book_id = ?')
          .get(bookId) as { revision: number } | undefined
        const approvals = this.db
          .prepare(
            `SELECT book_id, segment_id, speaker_id, fallback_reason, voice_profile_id,
                    source_text_sha256, decided_at, decided_by, grant_id, approval_id, approval_sha256
               FROM fallback_approvals WHERE book_id = ? ORDER BY segment_id`,
          )
          .all(bookId) as unknown as ApprovalRow[]
        const exclusions = this.db
          .prepare(
            `SELECT book_id, segment_id, decided_by, decided_at
               FROM fallback_approval_exclusions WHERE book_id = ? ORDER BY segment_id`,
          )
          .all(bookId) as unknown as ExclusionRow[]
        const grantRow = this.db
          .prepare(
            `SELECT book_id, decided_by, decided_at, subjects_json, grant_id, grant_sha256
               FROM fallback_book_grants WHERE book_id = ?`,
          )
          .get(bookId) as GrantRow | undefined
        return Object.freeze({
          revision: revisionRow?.revision ?? 0,
          approvals: Object.freeze(approvals.map((row) => reconstructApproval(row))),
          exclusions: Object.freeze(
            exclusions.map(
              (row): FallbackApprovalExclusion =>
                Object.freeze({
                  bookId: row.book_id,
                  segmentId: row.segment_id,
                  decidedBy: row.decided_by,
                  decidedAt: row.decided_at,
                }),
            ),
          ),
          grant: grantRow === undefined ? undefined : reconstructGrant(grantRow),
        })
      },
      `Could not read fallback approvals for book ${bookId}; the workspace database stayed locked`,
    )
  }

  async save(record: PersistedFallbackApproval): Promise<void> {
    // Re-derived before it is stored. A record whose identity does not follow from its own decision
    // fields would authorize audio nobody can reproduce, and the reuse ledger is keyed on it.
    const canonical = createFallbackApprovalRecord(record)
    if (
      canonical.approvalId !== record.approvalId ||
      canonical.approvalSha256 !== record.approvalSha256
    ) {
      throw new DomainError(
        `Fallback approval for ${record.segmentId} does not match its own decision identity`,
      )
    }
    await withBusyRetryingTransaction(
      this.db,
      () => {
        this.db
          .prepare(
            `INSERT INTO fallback_approvals
               (book_id, segment_id, speaker_id, fallback_reason, voice_profile_id,
                source_text_sha256, decided_at, decided_by, grant_id, approval_id, approval_sha256)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(book_id, segment_id) DO UPDATE SET
               speaker_id = excluded.speaker_id,
               fallback_reason = excluded.fallback_reason,
               voice_profile_id = excluded.voice_profile_id,
               source_text_sha256 = excluded.source_text_sha256,
               decided_at = excluded.decided_at,
               decided_by = excluded.decided_by,
               grant_id = excluded.grant_id,
               approval_id = excluded.approval_id,
               approval_sha256 = excluded.approval_sha256`,
          )
          .run(
            canonical.bookId,
            canonical.segmentId,
            canonical.speakerId,
            canonical.fallbackReason,
            canonical.voiceProfileId,
            canonical.sourceTextSha256,
            canonical.decidedAt,
            canonical.decidedBy,
            canonical.grantId,
            canonical.approvalId,
            canonical.approvalSha256,
          )
        // Approving clears any earlier withdrawal: the human has decided again, and leaving the
        // exclusion would keep a book-wide grant permanently blocked for this segment.
        this.db
          .prepare('DELETE FROM fallback_approval_exclusions WHERE book_id = ? AND segment_id = ?')
          .run(canonical.bookId, canonical.segmentId)
        this.bumpRevision(canonical.bookId)
      },
      `Could not save the fallback approval for ${record.segmentId}; the workspace database stayed locked`,
    )
  }

  async revoke(
    bookId: string,
    segmentId: string,
    revocation: FallbackRevocation,
  ): Promise<boolean> {
    requireBookId(bookId)
    if (!segmentId || segmentId.length === 0) throw new DomainError('Segment ID is required')
    if (
      revocation.reason !== 'human-withdrawal' &&
      revocation.reason !== 'no-longer-describes-segment'
    ) {
      throw new DomainError('Unsupported fallback revocation')
    }
    const exclusion =
      revocation.reason === 'human-withdrawal'
        ? createFallbackApprovalExclusion({
            bookId,
            segmentId,
            decidedBy: revocation.decidedBy,
            decidedAt: revocation.decidedAt,
          })
        : undefined
    return withBusyRetryingTransaction(
      this.db,
      (): boolean => {
        const result = this.db
          .prepare('DELETE FROM fallback_approvals WHERE book_id = ? AND segment_id = ?')
          .run(bookId, segmentId)
        // A human withdrawal is recorded, a system invalidation is not. Without the record a
        // book-wide grant would re-create the approval on the next reconciliation and the
        // revocation would mean nothing; recording a *system* invalidation would instead
        // permanently block a segment whose decision merely needs re-deriving.
        if (exclusion !== undefined) {
          this.db
            .prepare(
              `INSERT INTO fallback_approval_exclusions (book_id, segment_id, decided_by, decided_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(book_id, segment_id) DO UPDATE SET
                 decided_by = excluded.decided_by,
                 decided_at = excluded.decided_at`,
            )
            .run(exclusion.bookId, exclusion.segmentId, exclusion.decidedBy, exclusion.decidedAt)
        }
        this.bumpRevision(bookId)
        return Number(result.changes) > 0
      },
      `Could not revoke the fallback approval for ${segmentId}; the workspace database stayed locked`,
    )
  }

  async saveBookGrant(grant: BookFallbackGrant): Promise<void> {
    const canonical = createBookFallbackGrant(grant)
    if (canonical.grantId !== grant.grantId || canonical.grantSha256 !== grant.grantSha256) {
      throw new DomainError(
        `Book fallback grant for ${grant.bookId} does not match its own decision identity`,
      )
    }
    await withBusyRetryingTransaction(
      this.db,
      () => {
        this.db
          .prepare(
            `INSERT INTO fallback_book_grants
               (book_id, decided_by, decided_at, subjects_json, grant_id, grant_sha256)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(book_id) DO UPDATE SET
               decided_by = excluded.decided_by,
               decided_at = excluded.decided_at,
               subjects_json = excluded.subjects_json,
               grant_id = excluded.grant_id,
               grant_sha256 = excluded.grant_sha256`,
          )
          .run(
            canonical.bookId,
            canonical.decidedBy,
            canonical.decidedAt,
            JSON.stringify(canonical.subjects),
            canonical.grantId,
            canonical.grantSha256,
          )
        this.bumpRevision(canonical.bookId)
      },
      `Could not save the book fallback grant for ${grant.bookId}; the workspace database stayed locked`,
    )
  }

  async revokeBookGrant(bookId: string): Promise<boolean> {
    requireBookId(bookId)
    return withBusyRetryingTransaction(
      this.db,
      (): boolean => {
        const result = this.db
          .prepare('DELETE FROM fallback_book_grants WHERE book_id = ?')
          .run(bookId)
        this.bumpRevision(bookId)
        return Number(result.changes) > 0
      },
      `Could not withdraw the book fallback grant for ${bookId}; the workspace database stayed locked`,
    )
  }

  /** Must only be called inside a transaction that also wrote the change it accounts for. */
  private bumpRevision(bookId: string): void {
    this.db
      .prepare(
        `INSERT INTO fallback_catalog_revisions (book_id, revision) VALUES (?, 1)
         ON CONFLICT(book_id) DO UPDATE SET revision = revision + 1`,
      )
      .run(bookId)
  }
}

function requireBookId(bookId: string): void {
  if (!bookId || bookId.length === 0) throw new DomainError('Book ID is required')
}

function reconstructApproval(row: ApprovalRow): PersistedFallbackApproval {
  if (
    row.fallback_reason !== 'unresolved_speaker' &&
    row.fallback_reason !== 'missing_speaker_voice'
  ) {
    throw new DomainError(`Fallback approval for ${row.segment_id} has an unsupported reason`)
  }
  // Re-derived on read for the same reason it is re-derived on write: a row edited by hand must not
  // be able to authorize a fallback voice with an identity that does not follow from the decision.
  const record = createFallbackApprovalRecord({
    bookId: row.book_id,
    segmentId: row.segment_id,
    speakerId: row.speaker_id,
    fallbackReason: row.fallback_reason,
    voiceProfileId: row.voice_profile_id,
    sourceTextSha256: row.source_text_sha256,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    grantId: row.grant_id,
  })
  if (record.approvalId !== row.approval_id || record.approvalSha256 !== row.approval_sha256) {
    throw new DomainError(
      `Stored fallback approval for ${row.segment_id} does not match its own decision identity`,
    )
  }
  return record
}

function reconstructGrant(row: GrantRow): BookFallbackGrant {
  let subjects: readonly BookFallbackGrantSubject[]
  try {
    const parsed: unknown = JSON.parse(row.subjects_json)
    if (!Array.isArray(parsed)) throw new Error('grant subjects are not an array')
    subjects = parsed as BookFallbackGrantSubject[]
  } catch {
    throw new DomainError(`Stored book fallback grant for ${row.book_id} has invalid subjects`)
  }
  const grant = createBookFallbackGrant({
    bookId: row.book_id,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    subjects,
  })
  if (grant.grantId !== row.grant_id || grant.grantSha256 !== row.grant_sha256) {
    throw new DomainError(
      `Stored book fallback grant for ${row.book_id} does not match its own decision identity`,
    )
  }
  return grant
}
