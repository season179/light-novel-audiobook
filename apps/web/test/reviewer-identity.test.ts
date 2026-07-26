/**
 * Issue #45 round 3, finding 1: `decided_by` was a required column filled with the constant
 * `'local-user'`. A constant satisfies the column and records nothing — the same lie as the default
 * policy, one layer down. These tests pin that the actor is supplied and never manufactured.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveReviewerIdentity as resolveApplicationReviewerIdentity } from '@light-novel-audiobook/application'
import { afterEach, describe, expect, it } from 'vitest'
import { createAudiobookWebApi } from '../src/server/composition-root.js'
import { REVIEWER_ENV_VARIABLE, resolveReviewerIdentity } from '../src/server/reviewer-identity.js'
import { createStubEpubBytes } from './support/stub-epub.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const workspaceRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'lna-reviewer-'))
  roots.push(root)
  return root
}

describe('reviewer identity (issue #45, round 3)', () => {
  it('delegates to the canonical application resolver by reference', () => {
    expect(resolveReviewerIdentity).toBe(resolveApplicationReviewerIdentity)
  })

  it('prefers the configured reviewer and trims it', () => {
    expect(resolveReviewerIdentity({ [REVIEWER_ENV_VARIABLE]: '  Ada Lovelace  ' })).toBe(
      'Ada Lovelace',
    )
  })

  it('falls back to the operating-system account, which is a fact rather than a literal', () => {
    // No configured value: the identity must still come from outside this codebase. Asserting it is
    // non-empty and *not* the old constant is the point; the exact username is the machine's.
    const resolved = resolveReviewerIdentity({})
    expect(resolved.length).toBeGreaterThan(0)
    expect(resolved).not.toBe('local-user')
  })

  it('fails closed when neither configuration nor an OS account can identify the reviewer', () => {
    expect(() => resolveReviewerIdentity({}, () => undefined)).toThrow(
      'Cannot record who approves a fallback voice',
    )
  })

  it('treats a blank, oversized or control-bearing configured value as absent', () => {
    // None of these may be accepted into a persisted decision or shown in the review UI, so an
    // unusable configured value must be ignored rather than stored.
    const unusable = ['', '   ', 'x'.repeat(129), `bad${String.fromCharCode(9)}actor`]
    for (const value of unusable) {
      const resolved = resolveReviewerIdentity({ [REVIEWER_ENV_VARIABLE]: value })
      expect(resolved).not.toBe(value)
      expect(resolved.trim()).toBe(resolved)
      expect(resolved.length).toBeGreaterThan(0)
    }
  })

  it('records the configured reviewer on every decision, and no constant', async () => {
    const api = await createAudiobookWebApi({
      workspaceRoot: await workspaceRoot(),
      reviewer: 'Grace Hopper',
    })
    const upload = await api.uploadEpub({
      fileName: 'attributed.epub',
      bytes: createStubEpubBytes('attributed'),
    })
    const started = await api.startGeneration({ uploadId: upload.uploadId })
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const job = await api.getJobState({ jobId: started.jobId })
      if (job !== null && !job.active && job.state === 'awaiting_review') break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    const after = await api.approveAllFallbacks({ jobId: started.jobId })
    expect(after.grantedBy).toBe('Grace Hopper')
    expect(after.items.length).toBeGreaterThan(0)
    expect(after.items.every((item) => item.decidedBy === 'Grace Hopper')).toBe(true)
    expect(after.items.some((item) => item.decidedBy === 'local-user')).toBe(false)
  }, 30_000)

  it('does not let the caller supply the actor at all', async () => {
    // Structural: the review operations take a single argument with no actor field, so a browser
    // cannot attest to who decided and the server cannot be talked into recording someone else.
    const api = await createAudiobookWebApi({
      workspaceRoot: await workspaceRoot(),
      reviewer: 'Grace Hopper',
    })
    expect(api.approveAllFallbacks.length).toBe(1)
    expect(api.revokeFallback.length).toBe(1)
  })
})
