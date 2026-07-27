import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createCastApprovalRecord,
  resolveReviewerIdentity,
} from '@light-novel-audiobook/application'
import { defaultFfmpegDirectory, FFMPEG_DIRECTORY_ENV } from '@light-novel-audiobook/audio-assembly'
import {
  layoutFor,
  openWorkspace,
  SqliteCastApprovalRepository,
} from '@light-novel-audiobook/persistence'
import { afterEach, describe, expect, it } from 'vitest'
import { runConfirmedRender, runPipeline } from '../src/driver.js'
import { NarrationEchoDirectorServer } from '../src/fake-director-server.js'
import { createFakeTransports } from '../src/transports.js'

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
/**
 * `synthetic-ncx-only` is used rather than the richer `synthetic-complex` because the latter carries an
 * SVG cover, and an SVG cover fails M4B export after everything else has succeeded (issue #61). This
 * driver reaches export on that fixture and dies there, so the working fixture is the honest choice
 * for pinning the happy path; the #61 encounter is recorded in the run report instead.
 */
const FIXTURE_EPUB = path.join(REPOSITORY_ROOT, 'tests/fixtures/epub/synthetic-ncx-only.epub')

/**
 * Real ffmpeg is the only thing here that is not a pure Node dependency, and it is what turns the run
 * into an actual M4B. Announce a skip loudly rather than letting the coverage quietly vanish, matching
 * the pattern the audio-assembly integration suite already uses.
 */
const TOOLCHAIN_DIRECTORY = path.resolve(
  process.env[FFMPEG_DIRECTORY_ENV] ?? defaultFfmpegDirectory(),
)
const TOOLCHAIN_PRESENT =
  existsSync(path.join(TOOLCHAIN_DIRECTORY, 'ffmpeg')) &&
  existsSync(path.join(TOOLCHAIN_DIRECTORY, 'ffprobe'))
if (!TOOLCHAIN_PRESENT) {
  process.stderr.write(
    `[skipped] pipeline-driver end-to-end coverage did not run: pinned ffmpeg/ffprobe not found in ${TOOLCHAIN_DIRECTORY}.\n` +
      `[skipped] Install the project FFmpeg toolchain or set ${FFMPEG_DIRECTORY_ENV} to run it.\n`,
  )
}

const REVIEWER = resolveReviewerIdentity({ LNA_REVIEWER: 'pipeline-driver-test' })
const workspaces: string[] = []
const servers: NarrationEchoDirectorServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  await Promise.all(workspaces.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function workspace(label: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `pipeline-driver-${label}-`))
  workspaces.push(root)
  return root
}

async function directorServer(): Promise<NarrationEchoDirectorServer> {
  const server = new NarrationEchoDirectorServer()
  servers.push(server)
  await server.start()
  return server
}

describe.skipIf(!TOOLCHAIN_PRESENT)('pipeline driver with fake transports', () => {
  it('stops a zero-warning book at review without creating audio', async () => {
    const workspaceRoot = await workspace('fixture')
    const server = await directorServer()
    const transports = await createFakeTransports(
      { runtimeDirectory: path.join(workspaceRoot, 'runtime'), repositoryRoot: REPOSITORY_ROOT },
      server.baseUrl,
    )

    const requestReceipts: Array<Record<string, unknown>> = []
    const report = await runPipeline({
      jobId: 'driver-fixture-run',
      epubPath: FIXTURE_EPUB,
      workspaceRoot,
      repositoryRoot: REPOSITORY_ROOT,
      transports,
      limits: { maxChapters: 1, maxPassagesPerChapter: 1 },
      onDirectorRequestReceipt: (receipt) => {
        requestReceipts.push({ ...receipt })
      },
    })

    // Direction succeeds without requiring or producing an audiobook.
    expect(report.operation).toBe('direction')
    expect(report.m4bBytes).toBeNull()
    expect(report.m4bPath).toBeNull()
    expect(report.outputVersion).toBeNull()
    expect(report.chapterOutputs).toEqual([])
    expect(report.jobState).toBe('awaiting_review')
    expect(report.jobStage).toBe('directing')
    expect(report.bookId).toMatch(/^book-[0-9a-f]{24}$/)
    expect(report.fallbackWarnings).toBe(0)

    // The slice bounded direction and rendering without bounding extraction.
    expect(report.slice?.sliced).toBe(true)
    expect(report.slice?.slicedChapters).toBe(1)
    expect(report.slice?.slicedPassages).toBe(1)
    // Extraction was NOT bounded: the real extractor still ingested the whole publication.
    expect(report.slice?.extractedChapters).toBe(2)
    expect(report.slice?.extractedPassages).toBe(2)
    expect(report.generatedSegments).toBe(0)
    expect(report.reusedSegments).toBe(0)

    // Every adapter contributed a real identity to the run.
    for (const identity of Object.values(report.identities)) {
      expect(identity.length).toBeGreaterThan(0)
    }

    // Gemma is released and Qwen never starts by itself at the boundary.
    expect(report.lifecycleEvents.indexOf('director:release')).toBeGreaterThanOrEqual(0)
    expect(report.lifecycleEvents).not.toContain('lease:acquire:qwen3-tts')

    // The fake transport was asked for exactly the sliced chapters, one request each.
    expect(server.requests).toHaveLength(1)
    expect(server.requests.map((request) => request.passageCount)).toEqual([1])
    expect(requestReceipts).toHaveLength(1)
    expect(requestReceipts[0]).toMatchObject({
      schema: 'gemma-director-request-receipt@1',
      ordinal: 1,
      passageCount: 1,
      responseStatus: 200,
      responseCompleted: true,
    })
  }, 600_000)

  it('loads the approved cast from the review ledger and resolves character-bearing segments', async () => {
    const workspaceRoot = await workspace('approved-cast')
    const firstServer = await directorServer()
    const first = await runPipeline({
      jobId: 'driver-cast-book-identity',
      epubPath: FIXTURE_EPUB,
      workspaceRoot,
      repositoryRoot: REPOSITORY_ROOT,
      transports: await createFakeTransports(
        {
          runtimeDirectory: path.join(workspaceRoot, 'runtime-first'),
          repositoryRoot: REPOSITORY_ROOT,
        },
        firstServer.baseUrl,
      ),
      limits: { maxChapters: 1, maxPassagesPerChapter: 1 },
    })
    const epubSha256 = createHash('sha256')
      .update(await readFile(FIXTURE_EPUB))
      .digest('hex')
    const database = openWorkspace(layoutFor(workspaceRoot))
    try {
      await new SqliteCastApprovalRepository(database).saveCastApproval(
        createCastApprovalRecord({
          bookId: first.bookId,
          epubSha256,
          assignments: [
            {
              speakerId: 'speaker-amber',
              aliases: ['Amber'],
              materialProfileId: 'ryan-energetic-baseline',
              sharingGroupId: null,
            },
          ],
          decidedBy: 'Reviewer One',
          decidedAt: '2026-07-26T12:00:00.000Z',
        }),
      )
    } finally {
      database.close()
    }

    const characterServer = new NarrationEchoDirectorServer('dialogue')
    servers.push(characterServer)
    await characterServer.start()
    const castRun = await runPipeline({
      jobId: 'driver-approved-cast-run',
      epubPath: FIXTURE_EPUB,
      workspaceRoot,
      repositoryRoot: REPOSITORY_ROOT,
      transports: await createFakeTransports(
        {
          runtimeDirectory: path.join(workspaceRoot, 'runtime-cast'),
          repositoryRoot: REPOSITORY_ROOT,
        },
        characterServer.baseUrl,
      ),
      limits: { maxChapters: 1, maxPassagesPerChapter: 1 },
    })

    expect(castRun.cast).toMatchObject({
      approvalId: expect.stringMatching(/^cast-/),
      characterCount: 1,
      distinctMaterialCount: 1,
      sharedMaterialGroupCount: 0,
      characterSharesFallbackMaterial: false,
    })
    expect(castRun.fallbackWarnings).toBe(0)
    expect(castRun.jobState).toBe('awaiting_review')
  }, 600_000)

  it('flags a character cast onto the fallback voice material in the run report', async () => {
    const workspaceRoot = await workspace('fallback-material-cast')
    const firstServer = await directorServer()
    const first = await runPipeline({
      jobId: 'driver-fallback-cast-book-identity',
      epubPath: FIXTURE_EPUB,
      workspaceRoot,
      repositoryRoot: REPOSITORY_ROOT,
      transports: await createFakeTransports(
        {
          runtimeDirectory: path.join(workspaceRoot, 'runtime-first'),
          repositoryRoot: REPOSITORY_ROOT,
        },
        firstServer.baseUrl,
      ),
      limits: { maxChapters: 1, maxPassagesPerChapter: 1 },
    })
    const epubSha256 = createHash('sha256')
      .update(await readFile(FIXTURE_EPUB))
      .digest('hex')
    // The single character is cast onto the configured fallback material (ryan-low-weary), so it is
    // voice-indistinguishable from every unresolved fallback line. The run report must surface that.
    const database = openWorkspace(layoutFor(workspaceRoot))
    try {
      await new SqliteCastApprovalRepository(database).saveCastApproval(
        createCastApprovalRecord({
          bookId: first.bookId,
          epubSha256,
          assignments: [
            {
              speakerId: 'speaker-amber',
              aliases: ['Amber'],
              materialProfileId: 'ryan-low-weary',
              sharingGroupId: null,
            },
          ],
          decidedBy: 'Reviewer One',
          decidedAt: '2026-07-26T12:00:00.000Z',
        }),
      )
    } finally {
      database.close()
    }

    const characterServer = new NarrationEchoDirectorServer('dialogue')
    servers.push(characterServer)
    await characterServer.start()
    const castRun = await runPipeline({
      jobId: 'driver-fallback-cast-run',
      epubPath: FIXTURE_EPUB,
      workspaceRoot,
      repositoryRoot: REPOSITORY_ROOT,
      transports: await createFakeTransports(
        {
          runtimeDirectory: path.join(workspaceRoot, 'runtime-cast'),
          repositoryRoot: REPOSITORY_ROOT,
        },
        characterServer.baseUrl,
      ),
      limits: { maxChapters: 1, maxPassagesPerChapter: 1 },
    })

    expect(castRun.cast).toMatchObject({
      approvalId: expect.stringMatching(/^cast-/),
      characterCount: 1,
      distinctMaterialCount: 1,
      sharedMaterialGroupCount: 0,
      characterSharesFallbackMaterial: true,
    })
    expect(castRun.fallbackWarnings).toBe(0)
    expect(castRun.jobState).toBe('awaiting_review')
  }, 600_000)

  it('rejects an approved cast whose recorded book identity differs from the extracted book', async () => {
    const workspaceRoot = await workspace('mismatched-book-id')
    const server = await directorServer()
    const transports = await createFakeTransports(
      { runtimeDirectory: path.join(workspaceRoot, 'runtime'), repositoryRoot: REPOSITORY_ROOT },
      server.baseUrl,
    )
    const epubSha256 = createHash('sha256')
      .update(await readFile(FIXTURE_EPUB))
      .digest('hex')
    // The approval is bound to this EPUB by its exact epubSha256 (the ledger primary key), but its
    // recorded bookId names a different extracted identity. Use a mismatched ID of the SAME length as
    // the real extracted book id (book- + 24 chars), so only a real value comparison — not a
    // length comparison — distinguishes them. The driver's defence-in-depth cross-check must catch
    // the mismatch before the cast is trusted.
    const database = openWorkspace(layoutFor(workspaceRoot))
    try {
      await new SqliteCastApprovalRepository(database).saveCastApproval(
        createCastApprovalRecord({
          bookId: 'book-zzzzzzzzzzzzzzzzzzzzzzzz',
          epubSha256,
          assignments: [
            {
              speakerId: 'speaker-amber',
              aliases: ['Amber'],
              materialProfileId: 'ryan-energetic-baseline',
              sharingGroupId: null,
            },
          ],
          decidedBy: 'Reviewer One',
          decidedAt: '2026-07-26T12:00:00.000Z',
        }),
      )
    } finally {
      database.close()
    }

    let report: Awaited<ReturnType<typeof runPipeline>> | undefined
    await expect(
      (async () => {
        report = await runPipeline({
          jobId: 'driver-mismatched-book-id',
          epubPath: FIXTURE_EPUB,
          workspaceRoot,
          repositoryRoot: REPOSITORY_ROOT,
          transports,
          limits: { maxChapters: 1, maxPassagesPerChapter: 1 },
        })
      })(),
    ).rejects.toThrow(/belongs to a different extracted book identity/)
    // The mismatch is caught during extraction, before the cast is trusted or any output assembled,
    // so no run report is produced.
    expect(report).toBeUndefined()
  }, 600_000)

  it('reuses completed segment audio across explicit confirmed renders', async () => {
    const workspaceRoot = await workspace('resume')
    const limits = { maxChapters: 1, maxPassagesPerChapter: 1 }
    const first = await directorServer()
    const firstDirection = await runPipeline({
      jobId: 'driver-resume-run',
      epubPath: FIXTURE_EPUB,
      workspaceRoot,
      repositoryRoot: REPOSITORY_ROOT,
      transports: await createFakeTransports(
        { runtimeDirectory: path.join(workspaceRoot, 'runtime'), repositoryRoot: REPOSITORY_ROOT },
        first.baseUrl,
      ),
      limits,
    })
    const firstRender = await runConfirmedRender(
      {
        jobId: 'driver-resume-run',
        epubPath: FIXTURE_EPUB,
        workspaceRoot,
        repositoryRoot: REPOSITORY_ROOT,
        transports: await createFakeTransports(
          {
            runtimeDirectory: path.join(workspaceRoot, 'runtime-render'),
            repositoryRoot: REPOSITORY_ROOT,
          },
          first.baseUrl,
        ),
        limits,
      },
      REVIEWER,
    )
    expect(firstDirection.jobState).toBe('awaiting_review')
    expect(firstRender.generatedSegments).toBe(1)

    // A different job over the same workspace stands in for a restart after a crash: the segment
    // ledger is real, so the audio should be reused rather than re-rendered.
    const second = await directorServer()
    const secondDirection = await runPipeline({
      jobId: 'driver-resume-run-2',
      epubPath: FIXTURE_EPUB,
      workspaceRoot,
      repositoryRoot: REPOSITORY_ROOT,
      transports: await createFakeTransports(
        {
          runtimeDirectory: path.join(workspaceRoot, 'runtime-2'),
          repositoryRoot: REPOSITORY_ROOT,
        },
        second.baseUrl,
      ),
      limits,
    })
    const resumed = await runConfirmedRender(
      {
        jobId: 'driver-resume-run-2',
        epubPath: FIXTURE_EPUB,
        workspaceRoot,
        repositoryRoot: REPOSITORY_ROOT,
        transports: await createFakeTransports(
          {
            runtimeDirectory: path.join(workspaceRoot, 'runtime-render-2'),
            repositoryRoot: REPOSITORY_ROOT,
          },
          second.baseUrl,
        ),
        limits,
      },
      REVIEWER,
    )

    expect(secondDirection.jobState).toBe('awaiting_review')
    expect(resumed.jobState).toBe('completed')
    expect(resumed.identities.director).toBe(firstRender.identities.director)
    expect(resumed.reusedSegments).toBe(1)
    expect(resumed.generatedSegments).toBe(0)
    // A second export never overwrites the first.
    expect(resumed.outputVersion).toBe(2)
    expect(firstRender.m4bPath).not.toBeNull()
    if (firstRender.m4bPath === null) throw new Error('first confirmed render produced no M4B')
    expect(existsSync(firstRender.m4bPath)).toBe(true)
    expect(resumed.m4bPath).not.toBe(firstRender.m4bPath)
  }, 600_000)
})
