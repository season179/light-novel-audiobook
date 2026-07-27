import { readdir, readFile, stat } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

const upload = (fileName = 'the-lantern-courier.epub', marker = 'stub') =>
  harness.api.uploadEpub({ fileName, bytes: createStubEpubBytes(marker) })

/** Linux-only precision: `undefined` elsewhere, and the assertions using it are then skipped. */
const countOpenDescriptors = async (): Promise<number | undefined> => {
  try {
    return (await readdir('/proc/self/fd')).length
  } catch {
    return undefined
  }
}

const startAndFinish = async (uploadId: string) => {
  const started = await harness.api.startGeneration({ uploadId })
  return waitForJobState(harness.api, started.jobId, (job) => job.finished)
}

describe('AudiobookWebApi', () => {
  beforeEach(async () => {
    harness = await createTestHarness()
  })

  afterEach(async () => {
    await harness.dispose()
    vi.restoreAllMocks()
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

  it('forwards composition-root director options through the whole generation path', async () => {
    await harness.dispose()
    harness = await createTestHarness({ directorOptions: { timeoutMs: 42_000 } })

    const stored = await upload()
    const finished = await startAndFinish(stored.uploadId)

    expect(finished?.state).toBe('completed')
    expect(harness.directors).toHaveLength(1)
    expect(harness.directors[0]?.lastOptions?.timeoutMs).toBe(42_000)
  })

  it('reports malformed uploads with an actionable message', async () => {
    await expect(
      harness.api.uploadEpub({ fileName: 'notes.txt', bytes: createStubEpubBytes() }),
    ).rejects.toThrow(/\.epub/)

    await expect(
      harness.api.uploadEpub({
        fileName: 'story.epub',
        bytes: new TextEncoder().encode('this is not a container at all'),
      }),
    ).rejects.toThrow()
  })

  it('rejects generation for an upload that is not in the workspace', async () => {
    await expect(harness.api.startGeneration({ uploadId: 'f'.repeat(64) })).rejects.toMatchObject({
      code: 'unknown_upload',
    })
  })

  it('returns null job state for a job that was never started', async () => {
    expect(await harness.api.getJobState({ jobId: 'job-000000000000000000000000' })).toBeNull()
  })

  it('runs upload to playable chapters and a numbered M4B', async () => {
    const stored = await upload()
    const started = await harness.api.startGeneration({ uploadId: stored.uploadId })
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

  /**
   * Regression for the HIGH finding: `GenerateAudiobook` always releases the director, and a real
   * director's release is terminal, so a retained director serves the first book and fails every one
   * after it. Two distinct books through one API instance must both direct successfully.
   */
  it('generates two distinct books through one web API instance', async () => {
    const first = await upload('first-book.epub', 'first')
    const second = await upload('second-book.epub', 'second')
    expect(second.uploadId).not.toBe(first.uploadId)

    const firstJob = await startAndFinish(first.uploadId)
    const secondJob = await startAndFinish(second.uploadId)

    expect(firstJob.state).toBe('completed')
    expect(secondJob.state).toBe('completed')
    expect(secondJob.jobId).not.toBe(firstJob.jobId)
    expect(secondJob.bookId).not.toBe(firstJob.bookId)
    expect(secondJob.error).toBeNull()
    expect(secondJob.completedSegments).toBe(EXPECTED_SEGMENTS)
    expect(secondJob.output?.m4bFileName).toBe('second-book-v001.m4b')

    // One director per run, and each was released exactly once by the use case.
    expect(harness.directors).toHaveLength(2)
    expect(harness.directors.map((director) => director.isReleased)).toEqual([true, true])
  })

  it('serializes runs so two jobs never hold model adapters at the same time', async () => {
    const gate = new RenderGate(2)
    await harness.dispose()
    harness = await createTestHarness({ beforeRender: gate.beforeRender })

    const first = await upload('first-book.epub', 'first')
    const second = await upload('second-book.epub', 'second')

    const startedFirst = await harness.api.startGeneration({ uploadId: first.uploadId })
    await waitForJobState(harness.api, startedFirst.jobId, (job) => job.completedSegments >= 1)

    // The second job is accepted but must wait: only one director exists so far.
    const startedSecond = await harness.api.startGeneration({ uploadId: second.uploadId })
    expect(startedSecond.job.state).toBe('pending')
    expect(startedSecond.job.latestMessage).toBe('Waiting for the current generation to finish')
    expect(harness.directors).toHaveLength(1)

    gate.open()
    await waitForJobState(harness.api, startedFirst.jobId, (job) => job.finished)
    await waitForJobState(harness.api, startedSecond.jobId, (job) => job.finished)
    expect(harness.directors).toHaveLength(2)
  })

  it('reports fallback-speaker warnings for both unresolved and uncast speakers', async () => {
    const stored = await upload()
    const completed = await startAndFinish(stored.uploadId)

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
    const completed = await startAndFinish(stored.uploadId)
    const jobId = completed.jobId
    const chapterId = completed.output?.chapters[0]?.chapterId ?? ''

    const chapterFile = await harness.api.openChapterAudioFile({ jobId, chapterId })
    try {
      expect(chapterFile.descriptor.contentType).toBe('audio/wav')
      expect(chapterFile.descriptor.attachment).toBe(false)
      expect(harness.workspace.contains(chapterFile.descriptor.path)).toBe(true)
      expect((await readFile(chapterFile.descriptor.path)).subarray(0, 4).toString('latin1')).toBe(
        'RIFF',
      )
    } finally {
      await chapterFile.close()
    }

    const audiobookFile = await harness.api.openAudiobookFile({ jobId })
    try {
      expect(audiobookFile.descriptor.contentType).toBe('audio/mp4')
      expect(audiobookFile.descriptor.attachment).toBe(true)
      expect((await stat(audiobookFile.descriptor.path)).size).toBeGreaterThan(0)
    } finally {
      await audiobookFile.close()
    }

    await expect(
      harness.api.openChapterAudioFile({ jobId, chapterId: 'nope' }),
    ).rejects.toMatchObject({ code: 'output_unavailable' })
  })

  it('streams the opened file and releases its handle', async () => {
    const stored = await upload()
    const completed = await startAndFinish(stored.uploadId)
    const file = await harness.api.openAudiobookFile({ jobId: completed.jobId })

    const chunks: Uint8Array[] = []
    for await (const chunk of file.body() as unknown as AsyncIterable<Uint8Array>) {
      chunks.push(chunk)
    }
    const streamed = Buffer.concat(chunks)

    expect(streamed.byteLength).toBe(file.descriptor.byteLength)
    expect(streamed.subarray(0, 4).toString('latin1')).toBe('RIFF')
    // Consuming the body closed the handle; a second close must stay harmless.
    await expect(file.close()).resolves.toBeUndefined()
  })

  it('releases the file descriptor when a caller abandons the stream', async () => {
    const stored = await upload()
    const completed = await startAndFinish(stored.uploadId)
    const baseline = await countOpenDescriptors()

    // A browser that stops a download cancels the body; the descriptor must not be left to the GC.
    const file = await harness.api.openAudiobookFile({ jobId: completed.jobId })
    const reader = file.body().getReader()
    const first = await reader.read()
    expect(first.value?.byteLength).toBeGreaterThan(0)
    if (baseline !== undefined) {
      expect(await countOpenDescriptors()).toBeGreaterThan(baseline)
    }

    await reader.cancel()

    if (baseline !== undefined) {
      expect(await countOpenDescriptors()).toBe(baseline)
    }
    await expect(file.close()).resolves.toBeUndefined()
  })

  it('rejects a duplicate request while a job is still generating', async () => {
    const gate = new RenderGate(2)
    await harness.dispose()
    harness = await createTestHarness({ beforeRender: gate.beforeRender })

    const stored = await upload()
    const started = await harness.api.startGeneration({ uploadId: stored.uploadId })
    await waitForJobState(harness.api, started.jobId, (job) => job.completedSegments >= 1)

    const duplicate = await harness.api.startGeneration({ uploadId: stored.uploadId })
    expect(duplicate.job.state).toBe('running')

    gate.open()
    await waitForJobState(harness.api, started.jobId, (job) => job.finished)
  })

  it('reuses completed segment audio after a failed run instead of re-rendering it', async () => {
    let renderAttempts = 0
    const crashOnSixthSegment = async (): Promise<void> => {
      renderAttempts += 1
      if (renderAttempts === 6 || renderAttempts === 7) {
        throw new Error(`Simulated speech engine crash ${renderAttempts}`)
      }
    }
    await harness.dispose()
    harness = await createTestHarness({ beforeRender: crashOnSixthSegment })

    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const stored = await upload()
    const first = await harness.api.startGeneration({ uploadId: stored.uploadId })
    const failed = await waitForJobState(harness.api, first.jobId, (job) => job.state === 'failed')
    // The browser gets authored prose and an exact artifact path, never the adapter's own words.
    expect(failed.error).toContain('The local server hit an unexpected error.')
    expect(failed.failureDiagnosticPath).not.toBeNull()
    expect(failed.error).toContain(failed.failureDiagnosticPath as string)
    expect(failed.error).not.toContain('Simulated speech engine crash')
    expect(
      logged.mock.calls.some((call) =>
        call
          .map((argument) => String(argument))
          .join(' ')
          .includes('Simulated speech engine crash 6'),
      ),
    ).toBe(true)
    expect(harness.speechEngine.rendered).toBe(5)

    expect(failed.resumeDescription).toBe(
      'Recheck saved segment audio and render only the missing segments.',
    )
    await expect(harness.api.startGeneration({ uploadId: stored.uploadId })).rejects.toThrow(
      'Open the job to review what survived',
    )
    const second = await harness.api.resumeGeneration({ jobId: first.jobId })
    const failedAgain = await waitForJobState(
      harness.api,
      second.jobId,
      (job) => job.state === 'failed' && job.failureDiagnosticPath !== failed.failureDiagnosticPath,
    )
    expect(failedAgain.failureDiagnosticPath).not.toBe(failed.failureDiagnosticPath)
    await expect(readFile(failed.failureDiagnosticPath as string, 'utf8')).resolves.toContain(
      first.jobId,
    )

    const third = await harness.api.resumeGeneration({ jobId: first.jobId })
    const completed = await waitForJobState(harness.api, third.jobId, (job) => job.finished)

    expect(completed.completedSegments).toBe(EXPECTED_SEGMENTS)
    // Five clips survived the crash, so only the remaining eleven are rendered again.
    expect(harness.speechEngine.rendered).toBe(EXPECTED_SEGMENTS)
    // Stage-local resume neither extracts nor directs again.
    expect(harness.directors).toHaveLength(1)
    // Resume clears the active failed-state pointer, not either immutable history file.
    expect(completed.failureDiagnosticPath).toBeNull()
    await expect(readFile(failedAgain.failureDiagnosticPath as string, 'utf8')).resolves.toContain(
      first.jobId,
    )
  })
})
