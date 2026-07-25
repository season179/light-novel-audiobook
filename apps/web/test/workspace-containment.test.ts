import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
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

// File-scoped on purpose: every `describe` below needs a fresh workspace and a real outside file.
// These hooks used to sit inside the first suite, so later suites ran with a disposed harness and a
// missing outside file, and their assertions held for the wrong reasons.
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

describe('workspace containment for served files', () => {
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

/**
 * Load-shaped coverage for the round-2 HIGH: no request may ever serve outside bytes while the served
 * path is being replaced underneath it.
 *
 * Scope, stated honestly: this does NOT by itself prove the check/open ordering is what fixes the
 * race. Restoring the old pathname-then-open ordering still passes here across repeated runs, because
 * in-process the window between `realpath()` and `open()` is too narrow to land on reliably. The
 * ordering fix is evidenced by the live 5,000-request measurement over HTTP (115 leaks before, 0
 * after, with a 5,000-request no-attack control that served every request), reproduced independently
 * by review. What this test does give is a concurrency regression net plus a control, and the static
 * symlink/parent/traversal/directory cases below do fail without their checks.
 */
describe('no outside bytes are served while the path is replaced underneath', () => {
  it('serves no outside file while a concurrent swapper races the open', async () => {
    const job = await completeJob()
    const file = await harness.api.openAudiobookFile({ jobId: job.jobId })
    const realPath = file.descriptor.path
    const realBytes = await readFile(realPath)
    await file.close()

    const linkStaging = `${realPath}.staging-link`
    const fileStaging = `${realPath}.staging-file`

    // A swapper that keeps renaming over the served path while readers run concurrently. Sequential
    // alternation would only exercise the static states; landing inside the check/open window needs
    // the swap to be in flight, which is what made the original defect measurable.
    let swapping = true
    const swapper = (async () => {
      for (let flip = 0; swapping; flip += 1) {
        try {
          if (flip % 2 === 0) {
            await rm(linkStaging, { force: true })
            await symlink(outsidePath, linkStaging)
            await rename(linkStaging, realPath)
          } else {
            await writeFile(fileStaging, realBytes)
            await rename(fileStaging, realPath)
          }
        } catch {
          // A losing rename is expected while readers hold the path.
        }
      }
    })()

    let leaked = 0
    let served = 0
    let refused = 0
    const read = async (): Promise<void> => {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        try {
          const opened = await harness.api.openAudiobookFile({ jobId: job.jobId })
          const chunks: Uint8Array[] = []
          for await (const chunk of opened.body() as unknown as AsyncIterable<Uint8Array>) {
            chunks.push(chunk)
          }
          await opened.close()
          served += 1
          if (Buffer.concat(chunks).toString('latin1').includes('secret material')) leaked += 1
        } catch {
          refused += 1
        }
      }
    }

    await Promise.all(Array.from({ length: 8 }, read))
    swapping = false
    await swapper

    expect(served + refused).toBe(960)
    expect(refused).toBeGreaterThan(0)
    expect(leaked).toBe(0)

    // Control, so a route that refuses everything cannot pass this test: once the swapper stops and
    // the real output is back, a normal request serves the real bytes.
    await rm(realPath, { force: true })
    await writeFile(realPath, realBytes)
    const restored = await harness.api.openAudiobookFile({ jobId: job.jobId })
    const control: Uint8Array[] = []
    for await (const chunk of restored.body() as unknown as AsyncIterable<Uint8Array>) {
      control.push(chunk)
    }
    await restored.close()
    expect(Buffer.concat(control).byteLength).toBe(realBytes.byteLength)
  })
})

describe('only paths the job reserved are served', () => {
  it('refuses an in-workspace file that the job never reserved', async () => {
    const job = await completeJob()
    const rogue = join(harness.workspace.outputsDir, job.bookId ?? '', 'rogue-not-reserved.wav')
    await writeFile(rogue, 'bytes nobody reserved', 'utf8')

    // Containment is satisfied: it really is a regular file inside the workspace.
    const contained = await harness.workspace.openContainedFile(rogue)
    expect(contained.path).toBe(rogue)
    await contained.handle.close()

    // But nothing in the API surface will serve it, because it is not in the persisted output.
    await expect(
      harness.api.openChapterAudioFile({ jobId: job.jobId, chapterId: 'rogue-not-reserved' }),
    ).rejects.toMatchObject({ code: 'output_unavailable' })

    const served = job.output?.chapters.map((chapter) => chapter.fileName) ?? []
    expect(served).not.toContain('rogue-not-reserved.wav')
  })
})

/**
 * What the guarantee deliberately does not cover, measured rather than asserted.
 *
 * A hardlink and a plain overwrite are the same class of substitution to this route: both present as
 * ordinary in-workspace regular files, and both need write access to the workspace, which already
 * allows replacing the bytes outright. That is why refusing `nlink > 1` is not the boundary — it would
 * reject legitimate exports (the FFmpeg assembler places outputs with `link()`) while leaving the
 * cheaper overwrite untouched. Closing this needs a digest recorded when the output is produced and
 * verified when it is served, which `AudiobookOutput` does not carry.
 */
describe('content substitution needs workspace write access, whatever the mechanism', () => {
  const serve = async (jobId: string): Promise<string> => {
    const opened = await harness.api.openAudiobookFile({ jobId })
    const chunks: Uint8Array[] = []
    for await (const chunk of opened.body() as unknown as AsyncIterable<Uint8Array>) {
      chunks.push(chunk)
    }
    await opened.close()
    return Buffer.concat(chunks).toString('latin1')
  }

  it('treats a hardlink and a plain overwrite identically', async () => {
    const job = await completeJob()
    const file = await harness.api.openAudiobookFile({ jobId: job.jobId })
    const realPath = file.descriptor.path
    await file.close()
    expect(await serve(job.jobId)).not.toContain('secret material')

    // A hardlink has no symlink component, so descriptor containment cannot distinguish it.
    await rm(realPath)
    await link(outsidePath, realPath)
    const viaHardlink = await serve(job.jobId)
    expect((await lstat(realPath)).nlink).toBe(2)

    // The same substitution without any link at all, from the same access level.
    await rm(realPath)
    await writeFile(realPath, OUTSIDE_CONTENT, 'utf8')
    const viaOverwrite = await serve(job.jobId)
    expect((await lstat(realPath)).nlink).toBe(1)

    // Indistinguishable results: link topology is not what separates these from a real output.
    expect(viaHardlink).toBe(viaOverwrite)
  })
})
