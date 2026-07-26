import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SliceLimits } from '../src/client/audiobook-client.js'
import { deriveJobId } from '../src/server/audiobook-web-api.js'
import { parseJobId, sliceLimitsForJobId } from '../src/server/job-identity.js'
import { createStubEpubBytes } from './support/stub-epub.js'
import { createTestHarness, type TestHarness, waitForJobState } from './support/test-harness.js'

/**
 * Issue #84: a bounded slice can be started from the web API; two slices of one upload are two jobs
 * that cannot return each other's audio; an unqualified start is byte-identical to what it was.
 *
 * The fixture book has 3 chapters (4, 4 and 3 source passages) and renders to 16 segments
 * unbounded. No story text appears here — chapter labels and counts are structural.
 */
const FIXTURE_CHAPTERS = 3
const FIXTURE_SEGMENTS = 16

const SHA = 'a'.repeat(64)

let harness: TestHarness

const upload = (fileName = 'the-lantern-courier.epub') =>
  harness.api.uploadEpub({ fileName, bytes: createStubEpubBytes() })

/** Polls without the harness's auto-approval, so a job can be held at the review gate. */
const waitForState = async (jobId: string, state: string) => {
  const deadline = performance.now() + 10_000
  for (;;) {
    const job = await harness.api.getJobState({ jobId })
    if (job?.state === state) return job
    if (performance.now() > deadline) {
      throw new Error(`Job ${jobId} never reached ${state}; last seen ${job?.state ?? 'null'}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('bounded-slice job identity', () => {
  it('produces the historical ID for an unqualified start', () => {
    // Pinned against the rule main shipped: `job-<first 24 hex of the upload sha256>`, built here
    // from the literal rather than from the function under test.
    const historical = `job-${SHA.slice(0, 24)}`
    expect(deriveJobId(SHA)).toBe(historical)
    expect(deriveJobId(SHA, {})).toBe(historical)
    // `firstChapter: 1` spells the unbounded prefix, so it must not mint a second job for one window.
    expect(deriveJobId(SHA, { firstChapter: 1 })).toBe(historical)
  })

  it('gives every stated bound a distinct job, including one that spans the whole book', () => {
    const unbounded = deriveJobId(SHA)
    // Identity decision (#84): any stated non-default bound is a different job — even
    // `maxChapters: 3`, which spans the whole 3-chapter fixture book. The web API cannot know the
    // chapter count before extraction, so collapsing whole-book bounds into the unbounded job
    // would take a second rule that could disagree with the driver's; distinct fails safe
    // (a re-render of identical content, never the wrong audio).
    expect(deriveJobId(SHA, { maxChapters: FIXTURE_CHAPTERS })).not.toBe(unbounded)
    expect(deriveJobId(SHA, { maxChapters: 1 })).not.toBe(deriveJobId(SHA, { maxChapters: 2 }))
    expect(deriveJobId(SHA, { maxChapters: 1 })).not.toBe(
      deriveJobId(SHA, { firstChapter: 3, maxChapters: 1 }),
    )
    expect(deriveJobId(SHA, { maxChapters: 1 })).not.toBe(
      deriveJobId(SHA, { maxChapters: 1, maxPassagesPerChapter: 2 }),
    )
  })

  it('round-trips the bounds through the job ID', () => {
    const limits = { firstChapter: 3, maxChapters: 1 }
    const jobId = deriveJobId(SHA, limits)
    expect(parseJobId(jobId)).toEqual({ uploadSha256Prefix: SHA.slice(0, 24), limits })
    expect(sliceLimitsForJobId(jobId)).toEqual(limits)
    expect(sliceLimitsForJobId(deriveJobId(SHA))).toEqual({})
    // A pipeline-driver job ID is not a web job ID; it reads as unbounded, as it always has.
    expect(sliceLimitsForJobId('pipeline-demo-123')).toEqual({})
  })

  it.each([
    'firstChapter=0',
    'chapters=2',
    'unknown=1',
    // These parse as values, but deriveJobId would never mint these noncanonical spellings.
    'firstChapter=1',
    'maxChapters=01',
    'maxChapters=1,firstChapter=2',
    // A fourth alias-like form of our own: duplicate fields can never be canonical.
    'maxChapters=1,maxChapters=1',
  ])('rejects malformed or noncanonical descriptor %s loudly', (descriptor) => {
    const jobId = `job-${SHA.slice(0, 24)}-slice-${descriptor}`
    expect(parseJobId(jobId)).toBeNull()
    expect(() => sliceLimitsForJobId(jobId)).toThrow(/cannot be understood/)
  })

  const invalidBoundValues = [
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ] as const

  it.each(
    (['firstChapter', 'maxChapters', 'maxPassagesPerChapter'] as const).flatMap((bound) =>
      invalidBoundValues.map(([kind, value]) => [bound, kind, value] as const),
    ),
  )('rejects a %s value that is %s', (bound, _kind, value) => {
    expect(() => deriveJobId(SHA, { [bound]: value } as SliceLimits)).toThrow(/positive integer/)
  })
})

describe('bounded slices through the web API', () => {
  beforeEach(async () => {
    harness = await createTestHarness()
  })

  afterEach(async () => {
    await harness.dispose()
  })

  it('runs two slices of one upload as two jobs that cannot return each other’s audio', async () => {
    const stored = await upload()

    const startedA = await harness.api.startGeneration({
      uploadId: stored.uploadId,
      slice: { maxChapters: 1 },
    })
    const completedA = await waitForJobState(harness.api, startedA.jobId, (job) => job.finished)

    const startedB = await harness.api.startGeneration({
      uploadId: stored.uploadId,
      slice: { firstChapter: 3, maxChapters: 1 },
    })
    expect(startedB.jobId).not.toBe(startedA.jobId)
    const completedB = await waitForJobState(harness.api, startedB.jobId, (job) => job.finished)

    // Each job produced exactly its own window.
    expect(completedA.output?.chapters.map((chapter) => chapter.chapterLabel)).toEqual([
      'Chapter 1',
    ])
    expect(completedB.output?.chapters.map((chapter) => chapter.chapterLabel)).toEqual([
      'Chapter 3',
    ])
    expect(completedA.output?.chapters[0]?.chapterId).not.toBe(
      completedB.output?.chapters[0]?.chapterId,
    )

    // Re-reading the first job after the second completed must not return the second's output.
    const rereadA = await harness.api.requireJobState({ jobId: startedA.jobId })
    expect(rereadA.state).toBe('completed')
    expect(rereadA.output?.chapters.map((chapter) => chapter.chapterLabel)).toEqual(['Chapter 1'])
    const listingA = await harness.api.listChapterAudio({ jobId: startedA.jobId })
    const listingB = await harness.api.listChapterAudio({ jobId: startedB.jobId })
    expect(listingA.chapters[0]?.audioUrl).toContain(encodeURIComponent(startedA.jobId))
    expect(listingB.chapters[0]?.audioUrl).toContain(encodeURIComponent(startedB.jobId))

    // The audio bytes differ, and every segment was genuinely rendered: nothing was read back.
    const chapterA = completedA.output?.chapters[0]?.chapterId ?? ''
    const chapterB = completedB.output?.chapters[0]?.chapterId ?? ''
    const fileA = await harness.api.openChapterAudioFile({
      jobId: startedA.jobId,
      chapterId: chapterA,
    })
    const bytesA = await readFile(fileA.descriptor.path)
    await fileA.close()
    const fileB = await harness.api.openChapterAudioFile({
      jobId: startedB.jobId,
      chapterId: chapterB,
    })
    const bytesB = await readFile(fileB.descriptor.path)
    await fileB.close()
    expect(bytesA.equals(bytesB)).toBe(false)
    expect(harness.speechEngine.rendered).toBe(completedA.totalSegments + completedB.totalSegments)
  })

  it('resumes a review-paused slice into its own chapters after another slice ran meanwhile', async () => {
    const stored = await upload()

    // Slice A directs, then stops at the review gate with its script persisted.
    const startedA = await harness.api.startGeneration({
      uploadId: stored.uploadId,
      slice: { maxChapters: 1 },
    })
    await waitForState(startedA.jobId, 'awaiting_review')

    // Slice B runs its whole lifecycle while A is paused.
    const startedB = await harness.api.startGeneration({
      uploadId: stored.uploadId,
      slice: { firstChapter: 3, maxChapters: 1 },
    })
    const completedB = await waitForJobState(harness.api, startedB.jobId, (job) => job.finished)
    expect(completedB.output?.chapters.map((chapter) => chapter.chapterLabel)).toEqual([
      'Chapter 3',
    ])

    // A resumes — through the real review API — and must find its own script, not B's.
    await harness.api.approveAllFallbacks({ jobId: startedA.jobId })
    await harness.api.renderApprovedScript({ jobId: startedA.jobId })
    const completedA = await waitForJobState(harness.api, startedA.jobId, (job) => job.finished)
    expect(completedA.state).toBe('completed')
    expect(completedA.output?.chapters.map((chapter) => chapter.chapterLabel)).toEqual([
      'Chapter 1',
    ])
  })

  it('renders only the requested window', async () => {
    const stored = await upload()
    const started = await harness.api.startGeneration({
      uploadId: stored.uploadId,
      slice: { maxChapters: 1, maxPassagesPerChapter: 2 },
    })
    const completed = await waitForJobState(harness.api, started.jobId, (job) => job.finished)

    expect(completed.state).toBe('completed')
    // One chapter, the first, and strictly less work than the unbounded 3-chapter render.
    expect(completed.output?.chapters.map((chapter) => chapter.chapterLabel)).toEqual(['Chapter 1'])
    expect(completed.output?.chapters).toHaveLength(1)
    expect(completed.totalSegments).toBeGreaterThan(0)
    expect(completed.totalSegments).toBeLessThan(FIXTURE_SEGMENTS)
    // A fresh harness: everything the job reports was actually rendered in this run.
    expect(harness.speechEngine.rendered).toBe(completed.totalSegments)

    // The chapter audio on disk is exactly the one window's file.
    const listing = await harness.api.listChapterAudio({ jobId: started.jobId })
    expect(listing.chapters).toHaveLength(1)
    expect(listing.ready).toBe(true)
  })

  it('keeps an unqualified start on the historical job ID, beside slices of the same upload', async () => {
    const stored = await upload()
    const sliced = await harness.api.startGeneration({
      uploadId: stored.uploadId,
      slice: { maxChapters: 1 },
    })
    await waitForJobState(harness.api, sliced.jobId, (job) => job.finished)

    const started = await harness.api.startGeneration({ uploadId: stored.uploadId })
    // Pinned against the value main produces: derived here from the upload's sha256, not from the
    // function under test.
    expect(started.jobId).toBe(`job-${stored.sha256.slice(0, 24)}`)
    expect(started.jobId).not.toBe(sliced.jobId)
    const completed = await waitForJobState(harness.api, started.jobId, (job) => job.finished)
    expect(completed.output?.chapters).toHaveLength(FIXTURE_CHAPTERS)
    expect(completed.totalSegments).toBe(FIXTURE_SEGMENTS)
  })

  it('retains all available content when maxChapters is larger than the book', async () => {
    const stored = await upload()
    const started = await harness.api.startGeneration({
      uploadId: stored.uploadId,
      slice: { maxChapters: FIXTURE_CHAPTERS + 10 },
    })
    expect(started.jobId).not.toBe(`job-${stored.sha256.slice(0, 24)}`)
    const completed = await waitForJobState(harness.api, started.jobId, (job) => job.finished)
    expect(completed.output?.chapters).toHaveLength(FIXTURE_CHAPTERS)
    expect(completed.totalSegments).toBe(FIXTURE_SEGMENTS)
  })

  it('rejects an invalid bound before any job exists', async () => {
    const stored = await upload()
    await expect(
      harness.api.startGeneration({ uploadId: stored.uploadId, slice: { maxChapters: 0 } }),
    ).rejects.toMatchObject({ code: 'invalid_request' })
    expect(await harness.api.getJobState({ jobId: deriveJobId(stored.sha256) })).toBeNull()
  })
})
