import type { DatabaseSync } from 'node:sqlite'
import {
  createDirectionApprovalRecord,
  type DirectionApprovalQuery,
  type DirectionApprovalRepository,
  type PersistedDirectionApproval,
} from '@light-novel-audiobook/application'
import { DomainError } from '@light-novel-audiobook/domain'
import { withBusyRetryingTransaction } from './transaction.js'

interface DirectionApprovalRow {
  readonly approval_id: string
  readonly job_id: string
  readonly book_id: string
  readonly script_sha256: string
  readonly decided_by: string
  readonly decided_at: string
}

/** Append-only SQLite ledger for exact whole-script human confirmations. */
export class SqliteDirectionApprovalRepository implements DirectionApprovalRepository {
  constructor(private readonly db: DatabaseSync) {}

  async findDirectionApproval(
    query: DirectionApprovalQuery,
  ): Promise<PersistedDirectionApproval | undefined> {
    requireLookup(query)
    const row = this.db
      .prepare(
        `SELECT approval_id, job_id, book_id, script_sha256, decided_by, decided_at
           FROM direction_approvals
          WHERE job_id = ? AND book_id = ? AND script_sha256 = ?
          ORDER BY decided_at DESC, approval_id DESC
          LIMIT 1`,
      )
      .get(query.jobId, query.bookId, query.scriptSha256.toLowerCase()) as
      | DirectionApprovalRow
      | undefined
    return row === undefined ? undefined : reconstruct(row)
  }

  async saveDirectionApproval(approval: PersistedDirectionApproval): Promise<void> {
    const canonical = createDirectionApprovalRecord(approval)
    if (canonical.approvalId !== approval.approvalId) {
      throw new DomainError('Direction approval does not match its own decision identity')
    }
    await withBusyRetryingTransaction(
      this.db,
      () => {
        this.db
          .prepare(
            `INSERT INTO direction_approvals
               (approval_id, job_id, book_id, script_sha256, decided_by, decided_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(approval_id) DO NOTHING`,
          )
          .run(
            canonical.approvalId,
            canonical.jobId,
            canonical.bookId,
            canonical.scriptSha256,
            canonical.decidedBy,
            canonical.decidedAt,
          )
      },
      `Could not save the direction approval for job ${approval.jobId}; the workspace database stayed locked`,
    )
  }
}

const requireLookup = (query: DirectionApprovalQuery): void => {
  if (query.jobId.length === 0 || query.bookId.length === 0) {
    throw new DomainError('Direction approval lookup requires a job and book')
  }
  if (!/^[a-f\d]{64}$/i.test(query.scriptSha256)) {
    throw new DomainError('Direction approval lookup requires a script SHA-256')
  }
}

const reconstruct = (row: DirectionApprovalRow): PersistedDirectionApproval => {
  const canonical = createDirectionApprovalRecord({
    jobId: row.job_id,
    bookId: row.book_id,
    scriptSha256: row.script_sha256,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
  })
  if (canonical.approvalId !== row.approval_id) {
    throw new DomainError(`Stored direction approval ${row.approval_id} has invalid identity`)
  }
  return canonical
}
