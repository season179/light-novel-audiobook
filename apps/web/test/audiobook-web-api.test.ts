import { readFile, stat } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deriveJobId } from '../src/server/audiobook-web-api.js'
import { createStubEpubBytes } from './support/stub-epub.js'
import {
  createTestHarness,
  RenderGate,
  type TestHarness,
  waitForJobState,
} from './support/test-harness.js'

const EXPECTED_SEGMENTS = 16
const EXPECTED_CHAPTERS = 3

let harness: TestHarness

const upload = async (fileName = 'the-lantern-courier.epub', marker = 'stub') => {
  const result = await harness.api.uploadEpub({
    fileName,
    bytes: createStubEpubBytes(marker),
  })
  if (!result.ok) throw new Error(`Upload unexpectedly failed: ${result.error.message}`)
  return result.upload
}

describe('AudiobookWebApi', () => {
  beforeEach(async () => {
    harness = await createTestHarness()
  })

  afterEach(async () => {
    await harness.dispose()
  })

  it('stores an uploaded EPUB in the external workspace, never in the repository', async () => {
    const stored = await upload()

    expect(stored.jobId).toBe(deriveJobId(stored.sha256))
    expect(stored.byteLength).toBeGreaterThan(0)
    const uploads = await harness.api.listUploads()
    expect(uploads.map((entry) => entry.uploadId)).toContain(stored.uploadId)
    expect(harness.workspace.root.startsWith(process.cwd())).toBe(false)
  })

  it('returns the same upload and job identity for the same EPUB bytes', async () => {
    const first = await upload('story.epub')
    const second = await upload('story-copy.epub')

    expect(second.uploadId).toBe(first.uploadId)
    expect(second.jobId).toBe(first.jobId)
  })

  it('reports malformed uploads with an actionable message', async () => {
    const notAnEpub = await harness.api.uploadEpub({
      fileName: 'notes.txt',
      bytes: createStubEpubBytes(),
    })
    expect(notAnEpub).toEqual({
      ok: false,
      error: { code: 'invalid_upload', message: expect.stringContaining('.epub') },
    })

    const corrupt = await harness.api.uploadEpub({
      fileName: 'story.epub',
      bytes: new TextEncoder().encode('this is not a container at all'),
    })
    expect(corrupt.ok).toBe(false)
  })

  it('rejects generation for an upload that is not in the workspace', async () => {
    const result = await harness.api.startGeneration({ uploadId: 'f'.repeat(64) })
    expect(result).toEqual({
      ok: false,
      error: { code: 'unknown_upload', message: expect.any(String) },
    })
  })

  it('returns null job state for a job that was never started', async () => {
    expect(await harness.api.getJobState({ jobId: 'job-000000000000000000000000' })).toBeNull()
  })

  it('runs upload to playable chapters and a numbered M4B', async () => {
    const stored = await upload()
    const started = await harness.api.startGeneration({ uploadId: stored.uploadId })
    expect(started.ok).toBe(true)
    if (!started.ok) return

    const completed = await waitForJobState(harness.api, started.jobId, (job) => job.finished)

    expect(completed.state).toBe('completed')
    expect(completed.stage).toBe('completed')
    expect(completed.bookTitle).toBe('The Lantern Courier')
    expect(completed.totalSegments).toBe(EXPECTED_SEGMENTS)
    expect(completed.completedSegments).toBe(EXPECTED_SEGMENTS)
    expect(completed.percentComplete).toBe(100)
    expect(completed.error).toBeNull()

    const output = completed.output
    expect(output).not.toBeNull()
    if (output === null) return
    expect(output.versionLabel).toBe('v001')
    expect(output.m4bFileName).toBe('the-lantern-courier-v001.m4b')
    expect(output.chapters).toHaveLength(EXPECTED_CHAPTERS)
    expect(output.chapters.map((chapter) => chapter.chapterLabel)).toEqual([
      'Chapter 1',
      'Chapter 2',
      'Chapter 3',
    ])
    expect(output.chapters[0]?.title).toBe('The Lamp on the Bridge')
    expect(output.chapters[0]?.audioUrl).toBe(
      `/api/jobs/${started.jobId}/audio/${output.chapters[0]?.chapterId}`,
    )

    const listing = await harness.api.listChapterAudio({ jobId: started.jobId })
    expect(listing.ready).toBe(true)
    expect(listing.chapters).toHaveLength(EXPECTED_CHAPTERS)
    expect(listing.download?.fileName).toBe(output.m4bFileName)
  })

  it('reports fallback-speaker warnings for both unresolved and uncast speakers', async () => {
    const stored = await upload()
    const started = await harness.api.startGeneration({ uploadId: stored.uploadId })
    if (!started.ok) throw new Error('Generation was not accepted')
    const completed = await waitForJobState(harness.api, started.jobId, (job) => job.finished)

    const reasons = new Set(completed.warnings.map((warning) => warning.reason))
    expect(reasons).toEqual(new Set(['unresolved_speaker', 'missing_speaker_voice']))
    expect(completed.warnings.every((warning) => warning.message.length > 0)).toBe(true)
    expect(
      completed.warnings.every((warning) => warning.voiceProfileId === 'fallback-ryan-restrained'),
    ).toBe(true)
    expect(completed.warnings.map((warning) => warning.chapterLabel)).toContain('Chapter 1')
  })

  it('serves chapter audio and the M4B from persisted output only', async () => {
    const stored = await upload()
    const started = await harness.api.startGeneration({ uploadId: stored.uploadId })
    if (!started.ok) throw new Error('Generation was not accepted')
    const completed = await waitForJobState(harness.api, started.jobId, (job) => job.finished)
    const chapterId = completed.output?.chapters[0]?.chapterId ?? ''

    const chapterFile = await harness.api.readChapterAudioFile({
      jobId: started.jobId,
      chapterId,
    })
    expect(chapterFile.contentType).toBe('audio/wav')
    expect(chapterFile.attachment).toBe(false)
    expect(harness.workspace.contains(chapterFile.path)).toBe(true)
    expect((await readFile(chapterFile.path)).subarray(0, 4).toString('latin1')).toBe('RIFF')

    const audiobookFile = await harness.api.readAudiobookFile({ jobId: started.jobId })
    expect(audiobookFile.contentType).toBe('audio/mp4')
    expect(audiobookFile.attachment).toBe(true)
    expect((await stat(audiobookFile.path)).size).toBeGreaterThan(0)

    await expect(
      harness.api.readChapterAudioFile({ jobId: started.jobId, chapterId: 'nope' }),
    ).rejects.toThrow(/no generated audio/i)
  })

  it('rejects a duplicate request while a job is still generating', async () => {
    const gate = new RenderGate(2)
    await harness.dispose()
    harness = await createTestHarness({ beforeRender: gate.beforeRender })

    const stored = await upload()
    const started = await harness.api.startGeneration({ uploadId: stored.uploadId })
    if (!started.ok) throw new Error('Generation was not accepted')
    await waitForJobState(harness.api, started.jobId, (job) => job.completedSegments >= 1)

    const duplicate = await harness.api.startGeneration({ uploadId: stored.uploadId })
    expect(duplicate.ok).toBe(true)
    if (duplicate.ok) expect(duplicate.job.state).toBe('running')

    gate.open()
    await waitForJobState(harness.api, started.jobId, (job) => job.finished)
  })

  it('reuses completed segment audio after a failed run instead of re-rendering it', async () => {
    let renderAttempts = 0
    const crashOnSixthSegment = async (): Promise<void> => {
      renderAttempts += 1
      if (renderAttempts === 6) throw new Error('Simulated speech engine crash')
    }
    await harness.dispose()
    harness = await createTestHarness({ beforeRender: crashOnSixthSegment })

    const stored = await upload()
    const first = await harness.api.startGeneration({ uploadId: stored.uploadId })
    if (!first.ok) throw new Error('Generation was not accepted')
    const failed = await waitForJobState(harness.api, first.jobId, (job) => job.state === 'failed')
    expect(failed.error).toContain('Simulated speech engine crash')
    expect(harness.speechEngine.rendered).toBe(5)

    const second = await harness.api.startGeneration({ uploadId: stored.uploadId })
    if (!second.ok) throw new Error('Retry was not accepted')
    const completed = await waitForJobState(harness.api, second.jobId, (job) => job.finished)

    expect(completed.completedSegments).toBe(EXPECTED_SEGMENTS)
    // Five clips survived the crash, so only the remaining eleven are rendered again.
    expect(harness.speechEngine.rendered).toBe(EXPECTED_SEGMENTS)
  })
})
