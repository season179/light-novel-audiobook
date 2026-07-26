import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AudiobookJob,
  type AudiobookOutput,
  OutputVersion,
  StableIds,
} from '../../domain/src/index.js'
import { DomainEpubExtractor } from '../../epub-ingestion/src/index.js'
import {
  type ExclusiveGpuGate,
  type GpuLease,
  type GpuOwner,
  QwenTtsSpeechEngine,
  type SpeechSegmentRequest,
} from '../../qwen-tts/src/index.js'

/**
 * Composes the **real** EPUB extractor with the **real** downstream gates that consume its IDs.
 *
 * Every one of these gates was individually tested and passing before this file existed, and the
 * extractor's own contract test asserted its output was a valid domain `Book` — non-empty IDs,
 * positions in order, all true. What nothing did was put the real pair together, so the fact that
 * the extractor speaks a different ID dialect than three independent consumers require went
 * unnoticed. Hand-building a `Book` with `StableIds` is exactly what hid it, so nothing here builds
 * a `Book`: the only source of IDs is a real ingestion of a real archive.
 */

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = resolve(TEST_DIRECTORY, '../../..')
const FIXTURE_EPUB = join(REPOSITORY_ROOT, 'tests/fixtures/epub/synthetic-complex.epub')
const PRODUCTION_CONFIG = join(REPOSITORY_ROOT, 'config/qwen3-tts-production.json')
const MODEL_LOCK = join(REPOSITORY_ROOT, 'config/qwen3-tts-custom-voice.lock.json')
const UV_LOCK = join(REPOSITORY_ROOT, 'scripts/qwen3-tts-runtime/uv.lock')
const FAKE_WORKER = join(REPOSITORY_ROOT, 'packages/qwen-tts/test/fixtures/fake-qwen-process.mjs')

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `id-dialect-${label}-`))
  temporaryRoots.push(root)
  return root
}

/** Never leases anything: these tests must fail at ID validation, long before any GPU concern. */
class UnusedGpuGate implements ExclusiveGpuGate {
  async acquire(owner: GpuOwner): Promise<GpuLease> {
    return {
      owner,
      lockFilePath: '/unused',
      release: async () => undefined,
    }
  }
}

/** Ingests the fixture through the real adapter and mapper, returning the real domain `Book`. */
async function ingestRealBook() {
  const workspaceRoot = await temporaryRoot('workspace')
  const extractor = new DomainEpubExtractor({ workspaceRoot, repositoryRoot: REPOSITORY_ROOT })
  const book = await extractor.extract({ epubPath: FIXTURE_EPUB })
  const chapter = book.chapters[0]
  if (!chapter) throw new Error('fixture produced no chapters')
  const passage = chapter.sourcePassages[0]
  if (!passage) throw new Error('fixture produced no source passages')
  return { book, chapter, passage }
}

/** The production engine, with the segment-ID gate at its default strictness. */
async function realQwenEngine(): Promise<QwenTtsSpeechEngine> {
  const root = await temporaryRoot('qwen')
  const output = join(root, 'audio')
  const snapshot = join(root, 'snapshot')
  const workerScriptPath = join(root, 'fake-qwen-process.mjs')
  const runtimeManifestPath = join(root, 'runtime-manifest.json')
  await Promise.all([mkdir(output, { recursive: true }), mkdir(snapshot, { recursive: true })])
  await copyFile(FAKE_WORKER, workerScriptPath)
  await writeFile(
    runtimeManifestPath,
    `${JSON.stringify({
      schemaVersion: 1,
      immutable: true,
      pythonVersion: '3.12.13',
      uvLockSha256: '6a7d989924871b408ed0e6eea86ce21ff399033e1272c5fa19bf9a5e38c3bbd9',
      packages: [
        { name: 'qwen-tts', version: '0.1.1' },
        { name: 'torch', version: '2.9.1' },
        { name: 'torchaudio', version: '2.9.1' },
      ],
    })}\n`,
  )
  return await QwenTtsSpeechEngine.create({
    pythonExecutable: process.execPath,
    workerScriptPath,
    productionConfigPath: PRODUCTION_CONFIG,
    modelLockPath: MODEL_LOCK,
    runtimeManifestPath,
    uvLockPath: UV_LOCK,
    snapshotPath: snapshot,
    outputDirectory: output,
    repositoryRoot: REPOSITORY_ROOT,
    gpuGate: new UnusedGpuGate(),
    processEnvironment: { FAKE_QWEN_MODE: 'normal' },
    cancellationGraceMs: 500,
    // Left at the production default. The qwen contract test sets this true, which is one reason
    // its own suite never saw the dialect mismatch.
  })
}

/**
 * A real job attached to the real book and left in `directing`, which is the only stage that accepts
 * fallback warnings. `attachBook` deliberately does not check the ID dialect, so a real book gets
 * this far and the gates below are where it actually stops.
 */
function directingJob(bookId: string): AudiobookJob {
  const job = new AudiobookJob('job-id-dialect')
  job.bindCommand('c'.repeat(64))
  job.start()
  job.attachBook(bookId)
  job.beginDirection()
  return job
}

/** Drives a real job to the point where `complete()` applies `validateOutputContext`. */
function jobReadyToComplete(bookId: string, totalSegments: number): AudiobookJob {
  const job = directingJob(bookId)
  job.beginRendering(totalSegments)
  for (let index = 0; index < totalSegments; index += 1) {
    // Only checked for non-emptiness, so this is not the gate under test.
    job.recordSegmentCompleted(`rendered-segment-${index + 1}`)
  }
  job.beginAssembly()
  return job
}

describe('real extractor IDs against the real downstream gates', () => {
  it('passes the Qwen segment-ID gate on the first render of a real book', async () => {
    const { passage } = await ingestRealBook()
    const engine = await realQwenEngine()
    // Exactly what the render planner does with a real passage.
    const segmentId = StableIds.segment(passage.id, 1)
    // A configured narrator profile, so nothing here is a fallback needing a review approval: the
    // only thing under test is whether the ID derived from a real passage is accepted.
    const request: SpeechSegmentRequest = {
      segmentId,
      text: 'A short line of synthetic narration.',
      voiceProfileId: 'aiden-calm-narrator',
    }

    try {
      // `renderBatch` validates every request before it touches the worker or the GPU gate, so this
      // reaches the ID gate and nothing further.
      await engine.renderBatch([request])
    } finally {
      await engine.end?.()
    }
  })

  it('passes the job completion gate with a real book and real chapter IDs', async () => {
    const { book, chapter } = await ingestRealBook()
    const job = jobReadyToComplete(book.id, 1)
    const output: AudiobookOutput = {
      version: new OutputVersion(1),
      m4bPath: '/tmp/id-dialect/audiobook-v001.m4b',
      chapters: [{ chapterId: chapter.id, path: '/tmp/id-dialect/ch0001.flac' }],
    }

    // `complete()` runs validateOutputContext, which requires book-<24hex> and ${bookId}-chNNNN.
    // 0 is the catalog revision of a book with no recorded fallback decisions, which is this
    // fixture: the gate under test is the ID dialect, not approvals.
    job.complete(output, 0)

    expect(job.state).toBe('completed')
  })

  it('passes the fallback-warning gate for a real passage segment', async () => {
    const { book, passage } = await ingestRealBook()
    const job = directingJob(book.id)

    // The first unresolved speaker in a real book takes this path during direction.
    job.addFallbackWarning({
      segmentId: StableIds.segment(passage.id, 1),
      speakerId: null,
      voiceProfileId: 'narrator-aiden-calm',
      reason: 'unresolved_speaker',
    })

    expect(job.warnings).toHaveLength(1)
  })

  it('produces IDs in the dialect every consumer encodes', async () => {
    const { book, chapter, passage } = await ingestRealBook()

    // The dialect, asserted directly, so a regression names itself rather than surfacing as a
    // confusing failure three packages away.
    expect(book.id).toMatch(/^book-[0-9a-f]{24}$/)
    expect(chapter.id).toMatch(/^book-[0-9a-f]{24}-ch[0-9]{4}$/)
    expect(passage.id).toMatch(/^book-[0-9a-f]{24}-ch[0-9]{4}-p[0-9]{6}$/)
    expect(StableIds.segment(passage.id, 1)).toMatch(
      /^book-[0-9a-f]{24}-ch[0-9]{4}-p[0-9]{6}-s[0-9]{4}$/,
    )
    // Book-scoped, so two books cannot collide in a flat output root.
    expect(chapter.id.startsWith(`${book.id}-ch`)).toBe(true)
    expect(passage.id.startsWith(`${chapter.id}-p`)).toBe(true)
  })
})
