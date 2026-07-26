import { DatabaseSync } from 'node:sqlite'
import { createCastApprovalRecord } from '@light-novel-audiobook/application'
import { describe, expect, it } from 'vitest'
import { SqliteCastApprovalRepository } from '../src/cast-approvals.js'
import { migrateSchema } from '../src/schema.js'

const approval = (materialProfileId = 'material-bright') =>
  createCastApprovalRecord({
    bookId: 'book-abc123',
    epubSha256: 'a'.repeat(64),
    assignments: [
      {
        speakerId: 'speaker-amber',
        aliases: ['Amber'],
        materialProfileId,
        sharingGroupId: null,
      },
    ],
    decidedBy: 'Reviewer One',
    decidedAt: '2026-07-26T12:00:00.000Z',
  })

describe('SQLite cast approval ledger', () => {
  it('round-trips the canonical human decision', async () => {
    const db = new DatabaseSync(':memory:')
    migrateSchema(db)
    const repository = new SqliteCastApprovalRepository(db)
    const expected = approval()

    await repository.saveCastApproval(expected)

    expect(await repository.findCastApproval('A'.repeat(64))).toEqual(expected)
  })

  it('refuses a row whose stored decision identity was tampered with', async () => {
    const db = new DatabaseSync(':memory:')
    migrateSchema(db)
    const repository = new SqliteCastApprovalRepository(db)
    await repository.saveCastApproval(approval())
    db.prepare('UPDATE cast_approvals SET decided_by = ?').run('Somebody Else')

    await expect(repository.findCastApproval('a'.repeat(64))).rejects.toThrow(
      /does not match its own identity/,
    )
  })

  it('changing the assignment creates and persists a different approval identity', async () => {
    const db = new DatabaseSync(':memory:')
    migrateSchema(db)
    const repository = new SqliteCastApprovalRepository(db)
    const first = approval()
    const changed = approval('material-low')

    await repository.saveCastApproval(first)
    await repository.saveCastApproval(changed)

    expect(changed.approvalSha256).not.toBe(first.approvalSha256)
    expect(await repository.findCastApproval('a'.repeat(64))).toEqual(changed)
  })
})
