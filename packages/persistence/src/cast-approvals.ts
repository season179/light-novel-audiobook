import type { DatabaseSync } from 'node:sqlite'
import {
  type CastApprovalRepository,
  createCastApprovalRecord,
  type PersistedCastApproval,
} from '@light-novel-audiobook/application'
import { DomainError } from '@light-novel-audiobook/domain'
import { withBusyRetryingTransaction } from './transaction.js'

interface CastApprovalRow {
  readonly epub_sha256: string
  readonly book_id: string
  readonly assignments_json: string
  readonly decided_by: string
  readonly decided_at: string
  readonly approval_id: string
  readonly approval_sha256: string
}

/** Cast decisions in the same workspace review ledger as fallback decisions. */
export class SqliteCastApprovalRepository implements CastApprovalRepository {
  constructor(private readonly db: DatabaseSync) {}

  async findCastApproval(epubSha256: string): Promise<PersistedCastApproval | undefined> {
    requireSha256(epubSha256)
    const row = this.db
      .prepare(
        `SELECT epub_sha256, book_id, assignments_json, decided_by, decided_at,
                approval_id, approval_sha256
           FROM cast_approvals WHERE epub_sha256 = ?`,
      )
      .get(epubSha256.toLowerCase()) as CastApprovalRow | undefined
    if (row === undefined) return undefined
    return reconstruct(row)
  }

  async saveCastApproval(approval: PersistedCastApproval): Promise<void> {
    const canonical = createCastApprovalRecord(approval)
    if (
      canonical.approvalId !== approval.approvalId ||
      canonical.approvalSha256 !== approval.approvalSha256
    ) {
      throw new DomainError('Cast approval does not match its own decision identity')
    }
    await withBusyRetryingTransaction(
      this.db,
      () => {
        this.db
          .prepare(
            `INSERT INTO cast_approvals
               (epub_sha256, book_id, assignments_json, decided_by, decided_at,
                approval_id, approval_sha256)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(epub_sha256) DO UPDATE SET
               book_id = excluded.book_id,
               assignments_json = excluded.assignments_json,
               decided_by = excluded.decided_by,
               decided_at = excluded.decided_at,
               approval_id = excluded.approval_id,
               approval_sha256 = excluded.approval_sha256`,
          )
          .run(
            canonical.epubSha256,
            canonical.bookId,
            JSON.stringify(canonical.assignments),
            canonical.decidedBy,
            canonical.decidedAt,
            canonical.approvalId,
            canonical.approvalSha256,
          )
      },
      `Could not save the cast approval for book ${approval.bookId}; the workspace database stayed locked`,
    )
  }
}

const reconstruct = (row: CastApprovalRow): PersistedCastApproval => {
  let assignments: PersistedCastApproval['assignments']
  try {
    assignments = JSON.parse(row.assignments_json) as PersistedCastApproval['assignments']
  } catch {
    throw new DomainError(`Stored cast approval ${row.approval_id} has unreadable assignments`)
  }
  const canonical = createCastApprovalRecord({
    bookId: row.book_id,
    epubSha256: row.epub_sha256,
    assignments,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
  })
  if (
    canonical.approvalId !== row.approval_id ||
    canonical.approvalSha256 !== row.approval_sha256
  ) {
    throw new DomainError(`Stored cast approval ${row.approval_id} does not match its own identity`)
  }
  return canonical
}

const requireSha256 = (value: string): void => {
  if (!/^[a-f\d]{64}$/i.test(value)) throw new DomainError('EPUB identity must be a SHA-256 value')
}
