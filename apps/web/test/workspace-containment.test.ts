import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { audioFileErrorResponse, audioFileResponse } from '../src/server/audio-file-response.js'
import { createStubEpubBytes } from './support/stub-epub.js'
import { createTestHarness, type TestHarness, waitForJobState } from './support/test-harness.js'

/**
 * Regression for the MEDIUM finding: lexical `resolve()` containment accepted an in-workspace path
 * that was a symlink to somewhere else, and both binary routes streamed the outside file with a 200.
 */
let harness: TestHarness
let outsideDir: string
let outsidePath: string

const OUTSIDE_CONTENT = 'secret material that must never be served\n'

const completeJob = async () => {
  const stored = await harness.api.uploadEpub({
    fileName: 'the-lantern-courier.epub',
    bytes: createStubEpubBytes(),
  })
  const started = await harness.api.startGeneration({ uploadId: stored.uploadId })
  return waitForJobState(harness.api, started.jobId, (job) => job.finished)
}

/** Mirrors what the routes do, so a test failure means the real route is vulnerable. */
const serveChapter = async (jobId: string, chapterId: string): Promise<Response> => {
  try {
    return audioFileResponse(await harness.api.openChapterAudioFile({ jobId, chapterId }))
  } catch (error) {
    return audioFileErrorResponse(error, 'openChapterAudioFile')
  }
}

const serveAudiobook = async (jobId: string): Promise<Response> => {
  try {
    return audioFileResponse(await harness.api.openAudiobookFile({ jobId }))
  } catch (error) {
    return audioFileErrorResponse(error, 'openAudiobookFile')
  }
}

describe('workspace containment for served files', () => {
  beforeEach(async () => {
    harness = await createTestHarness()
    outsideDir = await mkdtemp(join(tmpdir(), 'lna-outside-'))
    outsidePath = join(outsideDir, 'outside.txt')
    await writeFile(outsidePath, OUTSIDE_CONTENT, 'utf8')
  })

  afterEach(async () => {
    await harness.dispose()
    await rm(outsideDir, { recursive: true, force: true })
  })

  it('refuses a chapter file that was replaced with a symlink pointing outside', async () => {
    const job = await completeJob()
    const chapter = job.output?.chapters[0]
    expect(chapter).toBeDefined()
    if (chapter === undefined) return

    const file = await harness.api.openChapterAudioFile({
      jobId: job.jobId,
      chapterId: chapter.chapterId,
    })
    const realPath = file.descriptor.path
    await file.close()

    await rm(realPath)
    await symlink(outsidePath, realPath)

    const response = await serveChapter(job.jobId, chapter.chapterId)
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain('secret material')
  })

  it('refuses the M4B when it was replaced with a symlink pointing outside', async () => {
    const job = await completeJob()
    const file = await harness.api.openAudiobookFile({ jobId: job.jobId })
    const realPath = file.descriptor.path
    await file.close()

    await rm(realPath)
    await symlink(outsidePath, realPath)

    const response = await serveAudiobook(job.jobId)
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain('secret material')
  })

  it('refuses a file whose parent directory is a symlink pointing outside', async () => {
    const job = await completeJob()
    const file = await harness.api.openAudiobookFile({ jobId: job.jobId })
    const realPath = file.descriptor.path
    await file.close()

    // Move the whole output directory outside and leave a symlink where it was.
    const outputsParent = join(harness.workspace.outputsDir, job.bookId ?? '')
    const relocated = join(outsideDir, 'relocated-outputs')
    await rename(outputsParent, relocated)
    await symlink(relocated, outputsParent)
    // The file itself is still reachable lexically through the symlinked parent.
    expect(realPath.startsWith(outputsParent)).toBe(true)

    const response = await serveAudiobook(job.jobId)
    expect(response.status).toBe(404)
  })

  it('refuses a persisted path that lexically escapes the workspace', async () => {
    const job = await completeJob()
    const escaping = join(harness.workspace.outputsDir, '..', '..', 'outside.txt')

    await expect(harness.workspace.openContainedFile(escaping)).rejects.toMatchObject({
      code: 'output_unavailable',
    })
    expect(harness.workspace.contains(escaping)).toBe(false)
    // The real job is unaffected and still serves.
    const ok = await serveAudiobook(job.jobId)
    expect(ok.status).toBe(200)
    // Draining the body is what releases the streamed file handle.
    expect((await ok.arrayBuffer()).byteLength).toBeGreaterThan(0)
  })

  it('refuses a directory even when it sits inside the workspace', async () => {
    const directory = join(harness.workspace.outputsDir, 'a-directory')
    await mkdir(directory, { recursive: true })

    await expect(harness.workspace.openContainedFile(directory)).rejects.toMatchObject({
      code: 'output_unavailable',
    })
  })

  it('refuses a workspace root that is a symlink into the repository', async () => {
    const { LocalWorkspace } = await import('../src/server/workspace.js')
    const linkPath = join(outsideDir, 'sneaky-workspace')
    await symlink(process.cwd(), linkPath)

    // Lexically outside the repository, but it canonically resolves inside it.
    await expect(new LocalWorkspace(linkPath).prepare()).rejects.toMatchObject({
      code: 'internal',
    })
  })
})
