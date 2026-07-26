import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultFfmpegDirectory, FFMPEG_DIRECTORY_ENV } from '@light-novel-audiobook/audio-assembly'
import { afterEach, describe, expect, it } from 'vitest'
import { runPipeline } from '../src/driver.js'
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
  it('takes a committed fixture EPUB through all five real adapters to a real M4B', async () => {
    const workspaceRoot = await workspace('fixture')
    const server = await directorServer()
    const transports = await createFakeTransports(
      { runtimeDirectory: path.join(workspaceRoot, 'runtime'), repositoryRoot: REPOSITORY_ROOT },
      server.baseUrl,
    )

    const report = await runPipeline({
      jobId: 'driver-fixture-run',
      epubPath: FIXTURE_EPUB,
      workspaceRoot,
      repositoryRoot: REPOSITORY_ROOT,
      transports,
      limits: { maxChapters: 1, maxPassagesPerChapter: 1 },
    })

    // A real export exists on disk, produced by pinned ffmpeg from real segment audio.
    expect(report.m4bBytes).toBeGreaterThan(0)
    expect(existsSync(report.m4bPath)).toBe(true)
    expect(report.m4bPath.endsWith('-v001.m4b')).toBe(true)
    expect(report.outputVersion).toBe(1)
    expect(report.chapterOutputs).toHaveLength(1)
    for (const chapter of report.chapterOutputs) {
      expect(chapter.bytes).toBeGreaterThan(0)
      expect(existsSync(chapter.path)).toBe(true)
    }

    // The job really completed, through the domain gates that rejected the old ID dialect.
    expect(report.jobState).toBe('completed')
    expect(report.jobStage).toBe('completed')
    expect(report.bookId).toMatch(/^book-[0-9a-f]{24}$/)
    expect(report.fallbackWarnings).toBe(0)

    // The slice bounded direction and rendering without bounding extraction.
    expect(report.slice?.sliced).toBe(true)
    expect(report.slice?.slicedChapters).toBe(1)
    expect(report.slice?.slicedPassages).toBe(1)
    // Extraction was NOT bounded: the real extractor still ingested the whole publication.
    expect(report.slice?.extractedChapters).toBe(2)
    expect(report.slice?.extractedPassages).toBe(2)
    expect(report.generatedSegments).toBe(1)
    expect(report.reusedSegments).toBe(0)

    // Every adapter contributed a real identity to the run.
    for (const identity of Object.values(report.identities)) {
      expect(identity.length).toBeGreaterThan(0)
    }

    // Gemma must have released the GPU before Qwen leased it, or both would be resident at once.
    const directorRelease = report.lifecycleEvents.indexOf('director:release')
    const speechAcquire = report.lifecycleEvents.indexOf('lease:acquire:qwen3-tts')
    expect(directorRelease).toBeGreaterThanOrEqual(0)
    expect(speechAcquire).toBeGreaterThan(directorRelease)

    // The fake transport was asked for exactly the sliced chapters, one request each.
    expect(server.requests).toHaveLength(1)
    expect(server.requests.map((request) => request.passageCount)).toEqual([1])
  }, 600_000)

  it('reuses completed segment audio when the same job is run again', async () => {
    const workspaceRoot = await workspace('resume')
    const first = await directorServer()
    const report = await runPipeline({
      jobId: 'driver-resume-run',
      epubPath: FIXTURE_EPUB,
      workspaceRoot,
      repositoryRoot: REPOSITORY_ROOT,
      transports: await createFakeTransports(
        { runtimeDirectory: path.join(workspaceRoot, 'runtime'), repositoryRoot: REPOSITORY_ROOT },
        first.baseUrl,
      ),
      limits: { maxChapters: 1, maxPassagesPerChapter: 1 },
    })
    expect(report.generatedSegments).toBe(1)

    // A different job over the same workspace stands in for a restart after a crash: the segment
    // ledger is real, so the audio should be reused rather than re-rendered.
    const second = await directorServer()
    const resumed = await runPipeline({
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
      limits: { maxChapters: 1, maxPassagesPerChapter: 1 },
    })

    expect(resumed.jobState).toBe('completed')
    expect(resumed.identities.director).toBe(report.identities.director)
    expect(resumed.reusedSegments).toBe(1)
    expect(resumed.generatedSegments).toBe(0)
    // A second export never overwrites the first.
    expect(resumed.outputVersion).toBe(2)
    expect(existsSync(report.m4bPath)).toBe(true)
    expect(resumed.m4bPath).not.toBe(report.m4bPath)
  }, 600_000)
})
