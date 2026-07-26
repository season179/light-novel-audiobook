/**
 * Issue #45 round 4, HIGH: a committed revocation left the assembled M4B downloadable, because only
 * `RenderAudiobook` compared the recorded approval-catalog revision. Round 3's review streamed 101,324
 * bytes of a revoked audiobook through the download route.
 *
 * These tests exercise the **download boundary**, not the application layer. Round 3's test called
 * `RenderAudiobook.execute()` first — which self-heals the job — and only then asserted the output was
 * "gone rather than still downloadable", without ever touching the download API. So nothing here calls
 * the render use case before reading: the read itself has to be the thing that refuses.
 *
 * What would still pass if the gate were absent? Only the first test — which is exactly why it is here.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AudiobookWebApi } from '../src/server/audiobook-web-api.js'
import { createAudiobookWebApi } from '../src/server/composition-root.js'
import { InMemoryFallbackApprovalRepository } from '../src/server/fakes/in-memory-fallback-approvals.js'
import { LocalWorkspace } from '../src/server/workspace.js'
import { createStubEpubBytes } from './support/stub-epub.js'

const REVIEWER = 'a-real-person'
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** Counts the bytes a download route actually streams, which is the only measure that matters here. */
const drain = async (api: AudiobookWebApi, jobId: string): Promise<number> => {
  const opened = await api.openAudiobookFile({ jobId })
  let bytes = 0
  try {
    const reader = opened.body().getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
    }
  } finally {
    await opened.close()
  }
  return bytes
}

interface Fixture {
  readonly api: AudiobookWebApi
  readonly jobId: string
  readonly bookId: string
  readonly approvals: InMemoryFallbackApprovalRepository
  readonly firstFallbackSegmentId: string
}

/** Runs a book all the way to a downloadable audiobook, making the one book-wide human decision. */
const completedAudiobook = async (
  marker: string,
  options: { readonly workspace?: (root: string) => LocalWorkspace } = {},
): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), 'lna-revoked-'))
  roots.push(root)
  const approvals = new InMemoryFallbackApprovalRepository()
  const workspace = options.workspace?.(root)
  await workspace?.prepare()
  const api = await createAudiobookWebApi({
    workspaceRoot: root,
    ...(workspace === undefined ? {} : { workspace }),
    reviewer: REVIEWER,
    approvals,
  })
  const upload = await api.uploadEpub({
    fileName: `${marker}.epub`,
    bytes: createStubEpubBytes(marker),
  })
  const started = await api.startGeneration({ uploadId: upload.uploadId })
  const settle = async (
    predicate: (job: Awaited<ReturnType<typeof api.getJobState>>) => boolean,
  ): Promise<void> => {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (predicate(await api.getJobState({ jobId: started.jobId }))) return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`job ${started.jobId} never settled`)
  }
  await settle((job) => job !== null && !job.active && job.state === 'awaiting_review')
  const review = await api.listFallbackReview({ jobId: started.jobId })
  const first = review.items[0]
  if (first === undefined) throw new Error('fixture produced no fallback segments')
  await api.approveAllFallbacks({ jobId: started.jobId })
  await api.renderApprovedScript({ jobId: started.jobId })
  await settle((job) => job !== null && job.finished)
  const bookId = (await api.getJobState({ jobId: started.jobId }))?.bookId
  if (bookId === null || bookId === undefined) throw new Error('job has no book')
  return { api, jobId: started.jobId, bookId, approvals, firstFallbackSegmentId: first.segmentId }
}

class PausingOpenWorkspace extends LocalWorkspace {
  private nextPause:
    | {
        readonly entered: () => void
        readonly waitForRelease: Promise<void>
      }
    | undefined

  pauseNextOpen(): {
    readonly entered: Promise<void>
    readonly release: () => void
  } {
    let markEntered: (() => void) | undefined
    let release: (() => void) | undefined
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    const waitForRelease = new Promise<void>((resolve) => {
      release = resolve
    })
    if (markEntered === undefined || release === undefined)
      throw new Error('pause was not initialized')
    this.nextPause = { entered: markEntered, waitForRelease }
    return { entered, release }
  }

  override async openContainedFile(candidate: string) {
    const pause = this.nextPause
    this.nextPause = undefined
    if (pause !== undefined) {
      pause.entered()
      await pause.waitForRelease
    }
    return super.openContainedFile(candidate)
  }
}

describe('a revoked audiobook is not downloadable (issue #45, round 4)', () => {
  it('serves the audiobook while every decision still stands', async () => {
    // The control. Without it, "deny when the revision moved" would be satisfied by denying always,
    // and the gate would look correct while breaking every finished audiobook.
    const { api, jobId } = await completedAudiobook('still-approved')

    const job = await api.getJobState({ jobId })
    expect(job?.state).toBe('completed')
    expect(job?.output).not.toBeNull()
    const listing = await api.listChapterAudio({ jobId })
    expect(listing.ready).toBe(true)
    expect(listing.download).not.toBeNull()
    expect(await drain(api, jobId)).toBeGreaterThan(0)
    const chapter = listing.chapters[0]
    if (chapter === undefined) throw new Error('fixture produced no chapters')
    await (await api.openChapterAudioFile({ jobId, chapterId: chapter.chapterId })).close()
  }, 60_000)

  /**
   * The state the race actually produces, constructed deterministically: the decision commits to the
   * ledger while the job still says `completed`, and **no reopen happens at all**.
   *
   * Reaching it by mutating the ledger directly is deliberate. Going through `revokeFallback` reopens
   * the job first, which would leave the gate's `not-completed` branch doing the work and prove
   * nothing about the revision comparison. It is also the exact residue of a lost race and of a failed
   * post-write reopen — the two shapes round 3's review reproduced — so one construction covers both.
   */
  it('refuses every reader of a completed output whose catalog moved, with no reopen at all', async () => {
    const { api, jobId, bookId, approvals, firstFallbackSegmentId } =
      await completedAudiobook('revoked-no-reopen')
    const listingBefore = await api.listChapterAudio({ jobId })
    expect(listingBefore.ready).toBe(true)
    const chapter = listingBefore.chapters[0]
    if (chapter === undefined) throw new Error('fixture produced no chapters')

    await approvals.revoke(bookId, firstFallbackSegmentId, {
      reason: 'human-withdrawal',
      decidedBy: REVIEWER,
      decidedAt: new Date().toISOString(),
    })

    // The download route is the FIRST read after the ledger moved. That ordering is the point: any
    // earlier read would itself reopen the job, and the refusal would then come from the gate's
    // `not-completed` branch — proving nothing about the revision comparison this finding is about.
    // The message asserted here is produced only by the moved-catalog branch.
    await expect(api.openAudiobookFile({ jobId })).rejects.toThrow(/no longer approved/)
    // The chapter route refuses too. By now the job has been reopened by the read above, so this
    // asserts only that it is refused — the specific branch is covered by the test below, where the
    // reopen can never succeed.
    await expect(
      api.openChapterAudioFile({ jobId, chapterId: chapter.chapterId }),
    ).rejects.toMatchObject({ code: 'output_unavailable' })
    // …and the listing and the projection agree, so the UI cannot offer a link to a refused file.
    const listing = await api.listChapterAudio({ jobId })
    expect(listing.ready).toBe(false)
    expect(listing.download).toBeNull()
    expect(listing.chapters).toEqual([])
    const view = await api.getJobState({ jobId })
    expect(view?.output).toBeNull()
    // The projection tells the truth rather than reporting a completed run with nothing to play.
    expect(view?.state).toBe('awaiting_review')
  }, 60_000)

  it('still refuses when the reopen cannot be saved, however often it is retried', async () => {
    // The second half of the finding: round 3's reopen was best-effort, so one failed save left the
    // audiobook downloadable indefinitely. The denial must be recomputed per read, not a consequence
    // of any save having succeeded.
    const { api, jobId, bookId, approvals, firstFallbackSegmentId } =
      await completedAudiobook('reopen-fails')
    await approvals.revoke(bookId, firstFallbackSegmentId, {
      reason: 'human-withdrawal',
      decidedBy: REVIEWER,
      decidedAt: new Date().toISOString(),
    })

    const jobs = jobRepositoryOf(api)
    const originalSaveJob = jobs.saveJob.bind(jobs)
    let refusedSaves = 0
    jobs.saveJob = async (job: { readonly state: string }): Promise<void> => {
      if (job.state === 'awaiting_review') {
        refusedSaves += 1
        throw new Error('injected snapshot write failure')
      }
      await originalSaveJob(job)
    }

    // Read it repeatedly: every attempt refuses, and every attempt fails to reopen.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(api.openAudiobookFile({ jobId })).rejects.toThrow(/no longer approved/)
      expect((await api.listChapterAudio({ jobId })).ready).toBe(false)
      expect((await api.getJobState({ jobId }))?.output).toBeNull()
    }
    expect(refusedSaves).toBeGreaterThan(0)

    // Restoring the write lets the self-heal finally land, so the denial is not a dead end.
    jobs.saveJob = originalSaveJob
    await api.getJobState({ jobId })
    expect((await api.getJobState({ jobId }))?.state).toBe('awaiting_review')
  }, 60_000)

  it('does not let a revocation commit between authorization and opening the descriptor', async () => {
    const workspaceHolder: { value?: PausingOpenWorkspace } = {}
    const { api, jobId, firstFallbackSegmentId } = await completedAudiobook(
      'authorize-open-atomic',
      {
        workspace: (root) => {
          const workspace = new PausingOpenWorkspace(root)
          workspaceHolder.value = workspace
          return workspace
        },
      },
    )
    const workspace = workspaceHolder.value
    if (workspace === undefined) throw new Error('fixture did not retain its workspace')
    const pause = workspace.pauseNextOpen()
    const opening = api.openAudiobookFile({ jobId })
    await pause.entered

    let revocationCommitted = false
    const revoking = api
      .revokeFallback({ jobId, segmentId: firstFallbackSegmentId })
      .then((result) => {
        revocationCommitted = true
        return result
      })
    // Give an uncoordinated mutation ample opportunity to commit while descriptor acquisition is
    // deliberately paused. Under the contract, the authorization owns this short window, so the
    // revocation must wait; it need not wait for the eventual stream body.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const committedWhileOpening = revocationCommitted

    pause.release()
    const opened = await opening
    await opened.close()
    await revoking

    expect(committedWhileOpening).toBe(false)
    await expect(api.openAudiobookFile({ jobId })).rejects.toMatchObject({
      code: 'output_unavailable',
    })
  }, 60_000)

  it('serves it again once the withdrawn speaker is approved and the book re-rendered', async () => {
    // Denial must be recoverable, or the gate is a trap rather than a gate.
    const { api, jobId } = await completedAudiobook('recovered')
    const review = await api.listFallbackReview({ jobId })
    const victim = review.items[0]
    if (victim === undefined) throw new Error('fixture has no fallback segments')

    await api.revokeFallback({ jobId, segmentId: victim.segmentId })
    await expect(api.openAudiobookFile({ jobId })).rejects.toMatchObject({
      code: 'output_unavailable',
    })

    // Approving *this speaker* is the recovery, not approving the book again: a withdrawal is a
    // durable exclusion that deliberately outranks the book-wide grant, so `approveAllFallbacks`
    // cannot undo it. Asserted here because that asymmetry would otherwise be a dead end.
    const stillBlocked = await api.approveAllFallbacks({ jobId })
    expect(stillBlocked.items.find((item) => item.segmentId === victim.segmentId)?.decision).toBe(
      'excluded',
    )
    const cleared = await api.approveFallback({ jobId, segmentId: victim.segmentId })
    expect(cleared.pendingCount).toBe(0)
    await api.renderApprovedScript({ jobId })
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const job = await api.getJobState({ jobId })
      if (job !== null && job.finished) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    expect((await api.listChapterAudio({ jobId })).ready).toBe(true)
    expect(await drain(api, jobId)).toBeGreaterThan(0)
  }, 60_000)
})

/** The API holds its repository privately; a test double has to reach it to inject a write failure. */
function jobRepositoryOf(api: AudiobookWebApi): {
  saveJob: (job: { readonly state: string }) => Promise<void>
} {
  return (
    api as unknown as { jobs: { saveJob: (job: { readonly state: string }) => Promise<void> } }
  ).jobs
}
