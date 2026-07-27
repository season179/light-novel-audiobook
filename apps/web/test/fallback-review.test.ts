/**
 * The web app's fallback-approval contract, asserted directly rather than through `waitForJobState`'s
 * convenience decision.
 *
 * Issue #45's round-2 review found that an optional policy whose omission approved every fallback
 * segment was the old `'auto-approve'` stand-in renamed. These tests pin the replacement: a run with
 * unresolved speakers stops, nothing is rendered, and only an explicit user action through the real
 * API creates approvals.
 */
import type { DirectedChapter } from '@light-novel-audiobook/application'
import type { Book, Chapter } from '@light-novel-audiobook/domain'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeDirectorModel } from '../src/server/fakes/fake-director-model.js'
import { createStubEpubBytes } from './support/stub-epub.js'
import {
  createTestHarness,
  TEST_REVIEWER,
  type TestHarness,
  waitForJobState,
} from './support/test-harness.js'

let harness: TestHarness | undefined

class NarrationOnlyDirector extends FakeDirectorModel {
  override async directChapter(_book: Book, chapter: Chapter): Promise<DirectedChapter> {
    return {
      chapterId: chapter.id,
      segments: chapter.sourcePassages.map((passage) => ({
        sourcePassageId: passage.id,
        sourceText: passage.sourceText,
        kind: 'narration',
        speakerId: null,
        confidence: 1,
        delivery: {
          emotion: 'neutral',
          pace: 'normal',
          volume: 'normal',
          pauseAfterMs: 100,
        },
      })),
    }
  }
}

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

/** Uploads the fixture EPUB and starts a run, returning the job once it settles for review. */
const startAndStopForReview = async (marker: string) => {
  harness = await createTestHarness()
  const api = harness.api
  const upload = await api.uploadEpub({
    fileName: `${marker}.epub`,
    bytes: createStubEpubBytes(marker),
  })
  const started = await api.startGeneration({ uploadId: upload.uploadId })
  // `waitForJobState` would make the decision itself, so this waits on the raw state instead.
  const deadline = performance.now() + 10_000
  while (performance.now() < deadline) {
    const job = await api.getJobState({ jobId: started.jobId })
    if (job !== null && !job.active && job.state === 'awaiting_review') break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return { api, jobId: started.jobId, harness: harness as TestHarness }
}

describe('fallback approvals in the web app (issue #45)', () => {
  it('makes the zero-warning ready-to-confirm boundary durable across a browser refresh', async () => {
    harness = await createTestHarness({ createDirectorModel: () => new NarrationOnlyDirector() })
    const upload = await harness.api.uploadEpub({
      fileName: 'zero-warning.epub',
      bytes: createStubEpubBytes('zero-warning'),
    })
    const started = await harness.api.startGeneration({ uploadId: upload.uploadId })
    const deadline = performance.now() + 10_000
    let boundary = await harness.api.getJobState({ jobId: started.jobId })
    while (
      performance.now() < deadline &&
      (boundary?.state !== 'awaiting_review' || boundary.active)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      boundary = await harness.api.getJobState({ jobId: started.jobId })
    }

    expect(boundary?.review).toEqual({ status: 'ready_to_confirm', blockers: 0, total: 0 })
    expect(boundary?.output).toBeNull()
    expect(harness.speechEngine.rendered).toBe(0)

    // A browser refresh performs the same fresh read from persisted state; it must not resume work.
    const refreshed = await harness.api.getJobState({ jobId: started.jobId })
    expect(refreshed).toMatchObject({
      state: 'awaiting_review',
      review: { status: 'ready_to_confirm', blockers: 0, total: 0 },
      output: null,
    })
    expect(harness.speechEngine.rendered).toBe(0)

    await harness.api.renderApprovedScript({ jobId: started.jobId })
    const completed = await waitForJobState(harness.api, started.jobId, (job) => job.finished)
    expect(completed.state).toBe('completed')
    expect(harness.speechEngine.rendered).toBeGreaterThan(0)
  })

  it('stops a book with unresolved speakers and renders nothing until a human decides', async () => {
    const { api, jobId, harness: app } = await startAndStopForReview('needs-review')

    const job = await api.getJobState({ jobId })
    expect(job?.state).toBe('awaiting_review')
    expect(job?.error).toBeNull()
    expect(job?.output).toBeNull()
    // Nothing was spoken. This is the assertion that would fail if any default approved the book.
    expect(app.speechEngine.rendered).toBe(0)
    expect(job?.totalSegments).toBe(0)

    const review = await api.listFallbackReview({ jobId })
    expect(review.awaitingReview).toBe(true)
    expect(review.grantedBy).toBeNull()
    expect(review.items.length).toBeGreaterThan(0)
    expect(review.pendingCount).toBe(review.items.length)
    expect(review.items.every((item) => item.decision === 'pending')).toBe(true)
    // Each entry is readable: nobody can approve a voice for a line they cannot read.
    expect(review.items.every((item) => item.sourceTextExcerpt.length > 0)).toBe(true)
    expect(review.items.every((item) => item.approvalId === null)).toBe(true)

    // Rendering cannot be forced past the gate either.
    await expect(api.renderApprovedScript({ jobId })).resolves.toMatchObject({ jobId })
    const stillWaiting = await waitForJobState(api, jobId, (state) => state.finished)
    expect(stillWaiting.state).toBe('completed')
  })

  it('derives the review status from the live records: an approval flips it with no new snapshot', async () => {
    const { api, jobId } = await startAndStopForReview('derived-review')
    const queue = await api.listFallbackReview({ jobId })

    const waiting = await api.getJobState({ jobId })
    expect(waiting?.state).toBe('awaiting_review')
    expect(waiting?.review).toEqual({
      status: 'needs_decisions',
      blockers: queue.items.length,
      total: queue.items.length,
    })

    await api.approveAllFallbacks({ jobId })

    const decided = await api.getJobState({ jobId })
    expect(decided?.review).toEqual({
      status: 'ready_to_confirm',
      blockers: 0,
      total: queue.items.length,
    })
    // The snapshot was never rewritten — same stored message, opposite answer. A projection read
    // from the message would still report needs_decisions here.
    expect(decided?.latestMessage).toBe(waiting?.latestMessage)
    expect(decided?.latestMessage).toContain('Awaiting fallback approval review')
    expect(harness?.speechEngine.rendered).toBe(0)
  })

  it('records one attributed decision per unresolved speaker from one book-wide action', async () => {
    const { api, jobId } = await startAndStopForReview('approve-all')
    const before = await api.listFallbackReview({ jobId })

    const after = await api.approveAllFallbacks({ jobId })

    expect(after.grantedBy).toBe(TEST_REVIEWER)
    expect(after.pendingCount).toBe(0)
    expect(after.items).toHaveLength(before.items.length)
    expect(after.items.every((item) => item.decision === 'approved')).toBe(true)
    expect(after.items.every((item) => item.decidedBy === TEST_REVIEWER)).toBe(true)
    // Per-segment records with distinct identities, never one blanket approval.
    const approvalIds = after.items.map((item) => item.approvalId)
    expect(approvalIds.every((id) => id !== null)).toBe(true)
    expect(new Set(approvalIds).size).toBe(approvalIds.length)
  })

  it('renders the approved script without re-extracting or re-directing it', async () => {
    const { api, jobId, harness: app } = await startAndStopForReview('render-approved')
    expect(app.directors).toHaveLength(1)

    await api.approveAllFallbacks({ jobId })
    await api.renderApprovedScript({ jobId })
    const finished = await waitForJobState(api, jobId, (state) => state.finished)

    expect(finished.state).toBe('completed')
    expect(finished.output).not.toBeNull()
    expect(app.speechEngine.rendered).toBeGreaterThan(0)
    // The review resume built no second director. With Gemma a second one would be an abandoned,
    // GPU-resident model whose `release()` had never been called.
    expect(app.directors).toHaveLength(1)
    expect(app.directors[0]?.isReleased).toBe(true)
  })

  it('reopens a completed book when one speaker is withdrawn, and only that speaker', async () => {
    const { api, jobId } = await startAndStopForReview('withdraw-one')
    await api.approveAllFallbacks({ jobId })
    await api.renderApprovedScript({ jobId })
    await waitForJobState(api, jobId, (state) => state.finished)

    const approved = await api.listFallbackReview({ jobId })
    const victim = approved.items[0]
    if (victim === undefined) throw new Error('fixture has no fallback segments')

    const after = await api.revokeFallback({ jobId, segmentId: victim.segmentId })

    // The completed job returned to review by itself and dropped its output.
    const job = await api.getJobState({ jobId })
    expect(job?.state).toBe('awaiting_review')
    expect(job?.output).toBeNull()
    // Exactly one decision moved.
    expect(after.pendingCount).toBe(1)
    expect(
      after.items.filter((item) => item.decision === 'excluded').map((item) => item.segmentId),
    ).toEqual([victim.segmentId])
    expect(after.items.filter((item) => item.decision === 'approved')).toHaveLength(
      approved.items.length - 1,
    )
  })

  it('refuses a decision while a render owns the job', async () => {
    harness = await createTestHarness()
    const api = harness.api
    const upload = await api.uploadEpub({
      fileName: 'busy.epub',
      bytes: createStubEpubBytes('busy'),
    })
    const started = await api.startGeneration({ uploadId: upload.uploadId })
    const deadline = performance.now() + 10_000
    while (performance.now() < deadline) {
      const job = await api.getJobState({ jobId: started.jobId })
      if (job !== null && !job.active && job.state === 'awaiting_review') break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await api.approveAllFallbacks({ jobId: started.jobId })
    const review = await api.listFallbackReview({ jobId: started.jobId })
    const victim = review.items[0]
    if (victim === undefined) throw new Error('fixture has no fallback segments')

    // While the render is queued or running the job is owned by it, so a decision that would change
    // the catalog underneath it is refused rather than queued behind it.
    await api.renderApprovedScript({ jobId: started.jobId })
    await expect(
      api.revokeFallback({ jobId: started.jobId, segmentId: victim.segmentId }),
    ).rejects.toThrow(/rendering/)

    await waitForJobState(api, started.jobId, (state) => state.finished)
  })
})
