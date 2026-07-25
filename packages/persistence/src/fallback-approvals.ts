import type { DatabaseSync } from 'node:sqlite'
import type {
  FallbackApprovalRepository,
  PersistedFallbackApproval,
} from '@light-novel-audiobook/application'
import { createFallbackApprovalRecord } from '@light-novel-audiobook/application'
import { DomainError } from '@light-novel-audiobook/domain'
import { withTransaction } from './transaction.js'

interface ApprovalRow {
  readonly book_id: string
  readonly segment_id: string
  readonly speaker_id: string | null
  readonly fallback_reason: string
  readonly voice_profile_id: string
  readonly source_text_sha256: string
  readonly decided_at: string
  readonly approval_id: string
  readonly approval_sha256: string
}

/**
 * The review context's ledger of persisted human fallback decisions, one live row per approved
 * unresolved-speaker segment.
 *
 * `save` is an upsert on `(book_id, segment_id)`: one segment has at most one live decision, and a
 * newer decision supersedes the older one rather than accumulating rows that a later query could
 * mistake for two live approvals.
 */
export class SqliteFallbackApprovalRepository implements FallbackApprovalRepository {
  constructor(private readonly db: DatabaseSync) {}

  async listForBook(bookId: string): Promise<readonly PersistedFallbackApproval[]> {
    if (!bookId || bookId.length === 0) throw new DomainError('Book ID is required')
    const rows = this.db
      .prepare(
        `SELECT book_id, segment_id, speaker_id, fallback_reason, voice_profile_id,
                source_text_sha256, decided_at, approval_id, approval_sha256
           FROM fallback_approvals WHERE book_id = ? ORDER BY segment_id`,
      )
      .all(bookId) as unknown as ApprovalRow[]
    return Object.freeze(rows.map((row) => reconstructApproval(row)))
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
    withTransaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO fallback_approvals
             (book_id, segment_id, speaker_id, fallback_reason, voice_profile_id,
              source_text_sha256, decided_at, approval_id, approval_sha256)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(book_id, segment_id) DO UPDATE SET
             speaker_id = excluded.speaker_id,
             fallback_reason = excluded.fallback_reason,
             voice_profile_id = excluded.voice_profile_id,
             source_text_sha256 = excluded.source_text_sha256,
             decided_at = excluded.decided_at,
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
          canonical.approvalId,
          canonical.approvalSha256,
        )
    })
  }

  async revoke(bookId: string, segmentId: string): Promise<boolean> {
    if (!bookId || bookId.length === 0) throw new DomainError('Book ID is required')
    if (!segmentId || segmentId.length === 0) throw new DomainError('Segment ID is required')
    return withTransaction(this.db, (): boolean => {
      const result = this.db
        .prepare('DELETE FROM fallback_approvals WHERE book_id = ? AND segment_id = ?')
        .run(bookId, segmentId)
      return Number(result.changes) > 0
    })
  }
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
  })
  if (record.approvalId !== row.approval_id || record.approvalSha256 !== row.approval_sha256) {
    throw new DomainError(
      `Stored fallback approval for ${row.segment_id} does not match its own decision identity`,
    )
  }
  return record
}
