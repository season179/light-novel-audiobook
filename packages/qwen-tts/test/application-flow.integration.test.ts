/**
 * End-to-end proof for issue #45.
 *
 * What is real here: `SqliteJobRepository`, `SqliteFallbackApprovalRepository`, the SQLite schema and
 * its migration, `DirectAudiobook` / `ReviewFallbackApprovals` / `RenderAudiobook`,
 * `QwenTtsSpeechEngine`, and **`QwenApplicationSpeechEngine` itself** — the merged adapter class,
 * reached through the same `createQwenSpeechEngineFactory` seam a composition root uses.
 *
 * What is faked, and only this: the *transport* under the speech engine (the pinned Python worker is
 * a fake child process, the GPU lease is an in-process gate), plus the EPUB extractor, the director
 * and the FFmpeg assembler — none of which #45 touches, and the first two of which cannot run here
 * (no EPUB, no GPU, no model loads). No fake speech engine and no injected repository: the
 * conditions under test are the persisted approval rows and the real adapter's gate, so substituting
 * either would be substituting the thing being proved.
 *
 * All story text below is invented for this fixture. The real EPUB is never read or quoted.
 */
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import {
  type AssembleAudiobookRequest,
  type AudioAssembler,
  DirectAudiobook,
  type DirectedChapter,
  type DirectorModel,
  type EpubExtractor,
  GenerateAudiobook,
  PendingFallbackReviewError,
  RenderAudiobook,
  ReviewFallbackApprovals,
  UnapprovedFallbackSegmentsError,
} from '@light-novel-audiobook/application'
import {
  type AudiobookOutput,
  Book,
  Chapter,
  type DeliveryDirection,
  type DirectedSegment,
  type SegmentKind,
  SourcePassage,
  StableIds,
  VoiceCast,
  VoiceProfile,
} from '@light-novel-audiobook/domain'
import {
  layoutFor,
  openWorkspace,
  SqliteFallbackApprovalRepository,
  SqliteJobRepository,
} from '@light-novel-audiobook/persistence'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createQwenSpeechEngineFactory,
  type ExclusiveGpuGate,
  type GpuLease,
  type GpuOwner,
  loadProductionConfig,
  QwenApplicationSpeechEngine,
  QwenTtsSpeechEngine,
  SpeechEngineError,
} from '../src/index.js'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPOSITORY_ROOT = resolve(PACKAGE_ROOT, '../..')
const PRODUCTION_CONFIG = join(REPOSITORY_ROOT, 'config/qwen3-tts-production.json')
const MODEL_LOCK = join(REPOSITORY_ROOT, 'config/qwen3-tts-custom-voice.lock.json')
const UV_LOCK = join(REPOSITORY_ROOT, 'scripts/qwen3-tts-runtime/uv.lock')
const FAKE_WORKER = join(PACKAGE_ROOT, 'test/fixtures/fake-qwen-process.mjs')

const SOURCE_HASH = 'd4f1'.repeat(16)
const BOOK_ID = StableIds.book(SOURCE_HASH)
const EPUB_PATH = '/uploads/fixture-light-novel.epub'
/** Fixed so every derived approval identity is reproducible run to run. */
const DECIDED_AT = new Date('2026-07-25T10:00:00.000Z')
const RE_DECIDED_AT = new Date('2026-07-25T11:30:00.000Z')

const delivery = (emotion: string): DeliveryDirection => ({
  emotion,
  pace: 'normal',
  volume: 'normal',
  pauseAfterMs: 220,
})

interface FixtureLine {
  readonly text: string
  readonly kind: SegmentKind
  readonly speakerId: string | null
  readonly emotion: string
}

/**
 * Two chapters, nine segments, six of them falling back — across three distinguishable unresolved
 * speakers: `mira` (3 segments), `kestrel` (1) and the unnamed speaker the director could not
 * attribute at all (2). Three distinct speakers is what makes "only that speaker's segments" a
 * measurement rather than a tautology; `mira` having three of them is what makes the count
 * non-trivial.
 */
const CHAPTER_LINES: readonly (readonly FixtureLine[])[] = [
  [
    {
      text: 'The lamp over the stairwell had been broken for weeks. ',
      kind: 'narration',
      speakerId: null,
      emotion: 'calm',
    },
    { text: '“You came back,” ', kind: 'dialogue', speakerId: 'alice', emotion: 'warm' },
    {
      text: '“Somebody has to lock the gate.” ',
      kind: 'dialogue',
      speakerId: null,
      emotion: 'flat',
    },
    {
      text: '“Not tonight, it is not our turn.” ',
      kind: 'dialogue',
      speakerId: 'mira',
      emotion: 'wary',
    },
    { text: '“Ask the keeper instead.”', kind: 'dialogue', speakerId: 'mira', emotion: 'tired' },
  ],
  [
    {
      text: 'Rain filled the courtyard before either of them moved. ',
      kind: 'narration',
      speakerId: null,
      emotion: 'calm',
    },
    {
      text: '“I told you the roof would go first.” ',
      kind: 'dialogue',
      speakerId: 'mira',
      emotion: 'dry',
    },
    {
      text: '“Then we start at the roof.” ',
      kind: 'dialogue',
      speakerId: 'kestrel',
      emotion: 'firm',
    },
    { text: '“Nobody asked either of you.”', kind: 'dialogue', speakerId: null, emotion: 'cold' },
  ],
]

const makeBook = (): Book => {
  const chapters = CHAPTER_LINES.map((lines, index) => {
    const chapterId = StableIds.chapter(BOOK_ID, index + 1)
    const passageId = StableIds.passage(chapterId, 1)
    return new Chapter({
      id: chapterId,
      bookId: BOOK_ID,
      position: index + 1,
      title: `Chapter ${index + 1}`,
      sourcePassages: [
        new SourcePassage({
          id: passageId,
          chapterId,
          sourceText: lines.map((line) => line.text).join(''),
        }),
      ],
    })
  })
  return new Book({
    id: BOOK_ID,
    title: 'Fixture Light Novel',
    author: 'Fixture Author',
    coverPath: null,
    source: { epubPath: EPUB_PATH, sha256: SOURCE_HASH },
    chapters,
  })
}

/** Segment IDs are position-derived, so they are known ahead of any run. */
const segmentIdsFor = (chapterIndex: number): readonly string[] => {
  const chapterId = StableIds.chapter(BOOK_ID, chapterIndex + 1)
  const passageId = StableIds.passage(chapterId, 1)
  const lines = CHAPTER_LINES[chapterIndex]
  if (lines === undefined) throw new Error('fixture chapter missing')
  return lines.map((_line, index) => StableIds.segment(passageId, index + 1))
}

const segmentsForSpeaker = (speakerId: string | null): readonly string[] =>
  CHAPTER_LINES.flatMap((lines, chapterIndex) => {
    const ids = segmentIdsFor(chapterIndex)
    return lines.flatMap((line, index) => {
      if (line.kind !== 'dialogue' || line.speakerId !== speakerId) return []
      const id = ids[index]
      return id === undefined ? [] : [id]
    })
  })

const TOTAL_SEGMENTS = CHAPTER_LINES.reduce((total, lines) => total + lines.length, 0)
const MIRA_SEGMENTS = segmentsForSpeaker('mira')
const FALLBACK_SEGMENT_COUNT = 6

class FixtureExtractor implements EpubExtractor {
  readonly identity = 'fixture-extractor:issue-45:1'
  extractions = 0

  async extract(): Promise<Book> {
    this.extractions += 1
    return makeBook()
  }
}

class FixtureDirector implements DirectorModel {
  readonly identity = 'fixture-director:issue-45:1'
  directed: string[] = []
  released = 0

  async directChapter(_book: Book, chapter: Chapter): Promise<DirectedChapter> {
    this.directed.push(chapter.id)
    const passage = chapter.sourcePassages[0]
    if (passage === undefined) throw new Error('fixture passage missing')
    const lines = CHAPTER_LINES[chapter.position - 1]
    if (lines === undefined) throw new Error('fixture chapter missing')
    const segments: DirectedSegment[] = lines.map((line) => ({
      sourcePassageId: passage.id,
      sourceText: line.text,
      kind: line.kind,
      speakerId: line.speakerId,
      confidence: line.speakerId === null && line.kind === 'dialogue' ? 0.4 : 0.97,
      delivery: delivery(line.emotion),
    }))
    return { chapterId: chapter.id, segments }
  }

  async release(): Promise<void> {
    this.released += 1
  }
}

/** Writes the files it reserved, so the flow is realistic; FFmpeg itself is issue #32's concern. */
class FixtureAssembler implements AudioAssembler {
  readonly identity = 'fixture-assembler:issue-45:1'
  assemblies = 0

  async assemble(request: AssembleAudiobookRequest): Promise<AudiobookOutput> {
    this.assemblies += 1
    for (const chapter of request.reservation.chapters) {
      await mkdir(dirname(chapter.path), { recursive: true })
      await writeFile(chapter.path, `chapter ${chapter.chapterId}\n`)
    }
    await writeFile(request.reservation.m4bPath, 'fixture m4b\n')
    return {
      version: request.reservation.version,
      m4bPath: request.reservation.m4bPath,
      chapters: request.reservation.chapters,
    }
  }
}

class FixtureGpuGate implements ExclusiveGpuGate {
  acquisitions = 0
  releases = 0

  async acquire(owner: GpuOwner, signal?: AbortSignal): Promise<GpuLease> {
    if (signal?.aborted) throw new Error('aborted')
    this.acquisitions += 1
    let released = false
    return {
      owner,
      lockFilePath: '/fixture/gpu.lock',
      release: async () => {
        if (!released) this.releases += 1
        released = true
      },
    }
  }
}

const roots: string[] = []
const databases: DatabaseSync[] = []

interface Fixture {
  readonly workspaceRoot: string
  readonly jobs: SqliteJobRepository
  readonly approvals: SqliteFallbackApprovalRepository
  readonly engine: QwenTtsSpeechEngine
  readonly gate: FixtureGpuGate
  readonly workerLog: string
  readonly voices: VoiceCast
  readonly extractor: FixtureExtractor
  readonly director: FixtureDirector
  readonly assembler: FixtureAssembler
}

/**
 * The cast is derived from the pinned production configuration rather than hardcoded, so a config
 * change cannot leave this test passing against voices the real engine would refuse.
 */
const castFromPinnedConfig = async (): Promise<VoiceCast> => {
  const production = await loadProductionConfig(PRODUCTION_CONFIG)
  const pinned = (id: string) => {
    const profile = production.value.voiceProfiles.find((candidate) => candidate.id === id)
    if (profile === undefined) throw new Error(`pinned profile ${id} is missing`)
    return profile
  }
  const narrator = pinned('aiden-calm-narrator')
  const character = pinned('ryan-energetic-baseline')
  const fallback = pinned(production.value.fallbackVoiceProfileId)
  const profile = (
    id: string,
    role: 'narrator' | 'character' | 'fallback',
    speakerId: string | null,
    source: { speaker: string; instruction: string; seedSalt: number },
  ): VoiceProfile =>
    new VoiceProfile({
      id,
      displayName: id,
      role,
      speakerId,
      syntheticSpeaker: source.speaker,
      instruction: source.instruction,
      seed: source.seedSalt,
      revision: 1,
    })
  return new VoiceCast(
    profile('cast-narrator', 'narrator', null, narrator),
    profile('cast-fallback', 'fallback', null, fallback),
    [profile('cast-alice', 'character', 'alice', character)],
  )
}

const makeFixture = async (): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), 'lna-issue-45-'))
  roots.push(root)
  // The workspace and the Qwen output root are separate directories, and both are outside the Git
  // worktree: the engine refuses an output directory inside the repository.
  const workspaceRoot = join(root, 'workspace')
  const engineRoot = join(root, 'engine')
  const output = join(engineRoot, 'audio')
  const snapshot = join(engineRoot, 'snapshot')
  const workerScriptPath = join(engineRoot, 'fake-qwen-process.mjs')
  const runtimeManifest = join(engineRoot, 'runtime-manifest.json')
  const workerLog = join(engineRoot, 'invocations.jsonl')
  await Promise.all([mkdir(output, { recursive: true }), mkdir(snapshot, { recursive: true })])
  await copyFile(FAKE_WORKER, workerScriptPath)
  await writeFile(
    runtimeManifest,
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

  const layout = layoutFor(workspaceRoot)
  const db = openWorkspace(layout)
  databases.push(db)
  const gate = new FixtureGpuGate()
  const engine = await QwenTtsSpeechEngine.create({
    pythonExecutable: process.execPath,
    workerScriptPath,
    productionConfigPath: PRODUCTION_CONFIG,
    modelLockPath: MODEL_LOCK,
    runtimeManifestPath: runtimeManifest,
    uvLockPath: UV_LOCK,
    snapshotPath: snapshot,
    outputDirectory: output,
    repositoryRoot: REPOSITORY_ROOT,
    gpuGate: gate,
    processEnvironment: { FAKE_QWEN_MODE: 'normal', FAKE_QWEN_LOG: workerLog },
    cancellationGraceMs: 500,
  })

  return {
    workspaceRoot,
    jobs: new SqliteJobRepository(layout, db),
    approvals: new SqliteFallbackApprovalRepository(db),
    engine,
    gate,
    workerLog,
    voices: await castFromPinnedConfig(),
    extractor: new FixtureExtractor(),
    director: new FixtureDirector(),
    assembler: new FixtureAssembler(),
  }
}

/** One entry per batch the real worker process actually served, with the segments it rendered. */
const workerBatches = async (path: string): Promise<{ segmentIds: string[] }[]> => {
  const raw = await readFile(path, 'utf8').catch(() => '')
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const call = JSON.parse(line) as { segments: { segmentId: string }[] }
      return { segmentIds: call.segments.map((segment) => segment.segmentId) }
    })
}

afterEach(async () => {
  for (const db of databases.splice(0)) {
    try {
      db.close()
    } catch {
      // Already closed by a failing test; the temporary root is removed either way.
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('issue #45 — real Qwen adapter over a book with unresolved speakers', () => {
  it('completes the book, persists one approval per unresolved segment, and re-renders only the speaker whose approval moved', async () => {
    const fixture = await makeFixture()
    const generate = new GenerateAudiobook({
      epubExtractor: fixture.extractor,
      directorModel: fixture.director,
      speechEngineFactory: createQwenSpeechEngineFactory(fixture.engine),
      audioAssembler: fixture.assembler,
      jobs: fixture.jobs,
      approvals: fixture.approvals,
      now: () => DECIDED_AT,
    })
    const command = {
      jobId: 'job-issue-45',
      epubPath: EPUB_PATH,
      epubSha256: SOURCE_HASH,
      voices: fixture.voices,
    }

    // ---- Run 1: a book with unresolved speakers completes through the real adapter. ------------
    const first = await generate.execute(command)
    expect(first.job.state).toBe('completed')
    expect(first.generatedSegments).toBe(TOTAL_SEGMENTS)
    expect(first.reusedSegments).toBe(0)
    expect(first.recordedFallbackApprovals).toBe(FALLBACK_SEGMENT_COUNT)
    expect(first.job.warnings).toHaveLength(FALLBACK_SEGMENT_COUNT)

    // Per-segment records, not one blanket approval, and every identity distinct.
    const stored = await fixture.approvals.listForBook(BOOK_ID)
    expect(stored).toHaveLength(FALLBACK_SEGMENT_COUNT)
    expect(new Set(stored.map((record) => record.approvalId)).size).toBe(FALLBACK_SEGMENT_COUNT)
    expect(new Set(stored.map((record) => record.approvalSha256)).size).toBe(FALLBACK_SEGMENT_COUNT)
    expect(stored.every((record) => record.voiceProfileId === 'cast-fallback')).toBe(true)
    expect(
      stored
        .filter((record) => record.fallbackReason === 'unresolved_speaker')
        .map((r) => r.speakerId),
    ).toEqual([null, null])
    expect(
      stored
        .filter((record) => record.fallbackReason === 'missing_speaker_voice')
        .map((record) => record.speakerId)
        .sort(),
    ).toEqual(['kestrel', 'mira', 'mira', 'mira'])

    // The real adapter bound each decision into that segment's own render manifest.
    const firstBatch = (await workerBatches(fixture.workerLog))[0]
    expect(firstBatch?.segmentIds).toHaveLength(TOTAL_SEGMENTS)
    for (const record of stored) {
      const manifest = JSON.parse(
        await readFile(
          join(fixture.workspaceRoot, '..', 'engine', 'audio', `${record.segmentId}.render.json`),
          'utf8',
        ),
      ) as { renderIdentity: { voice: { fallbackApproval: unknown } } }
      expect(manifest.renderIdentity.voice.fallbackApproval).toEqual({
        approvalId: record.approvalId,
        approvalSha256: record.approvalSha256,
      })
    }

    // ---- Run 2: nothing changed, so nothing re-renders. --------------------------------------
    // This assertion is load-bearing for the two that follow: unless reuse demonstrably engages
    // here, "only one speaker re-rendered" would be true of a run that re-rendered nothing at all.
    const reopened = await fixture.jobs.findJob(command.jobId)
    if (reopened === undefined) throw new Error('job vanished')
    reopened.reopenForReview()
    await fixture.jobs.saveJob(reopened)
    const second = await generate.execute(command)
    expect(second.generatedSegments).toBe(0)
    expect(second.reusedSegments).toBe(TOTAL_SEGMENTS)
    expect(second.recordedFallbackApprovals).toBe(0)
    // No approval identity moved, so the worker was never started a second time.
    expect(await workerBatches(fixture.workerLog)).toHaveLength(1)

    // ---- Run 3: revoke every approval for `mira` only. ---------------------------------------
    const review = new ReviewFallbackApprovals({
      jobs: fixture.jobs,
      approvals: fixture.approvals,
      now: () => RE_DECIDED_AT,
    })
    for (const segmentId of MIRA_SEGMENTS) {
      expect(await review.revoke({ jobId: command.jobId, segmentId })).toBe(true)
    }
    expect(await fixture.approvals.listForBook(BOOK_ID)).toHaveLength(
      FALLBACK_SEGMENT_COUNT - MIRA_SEGMENTS.length,
    )
    // Revoking on a completed job returned it to review by itself; its audio is now stale.
    const afterRevoke = await fixture.jobs.findJob(command.jobId)
    expect(afterRevoke?.state).toBe('awaiting_review')
    expect(afterRevoke?.output).toBeNull()

    const render = new RenderAudiobook({
      speechEngineFactory: createQwenSpeechEngineFactory(fixture.engine),
      audioAssembler: fixture.assembler,
      jobs: fixture.jobs,
      approvals: fixture.approvals,
    })
    const refusal = await render
      .execute({ jobId: command.jobId, voices: fixture.voices })
      .then(() => undefined)
      .catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(UnapprovedFallbackSegmentsError)
    // MEASURED: exactly mira's segments lost their authorization, and no others.
    expect((refusal as UnapprovedFallbackSegmentsError).segmentIds.slice().sort()).toEqual(
      MIRA_SEGMENTS.slice().sort(),
    )
    expect(await workerBatches(fixture.workerLog)).toHaveLength(1)

    // ---- Run 4: re-approve mira as a fresh decision; only her segments re-render. ------------
    for (const segmentId of MIRA_SEGMENTS) {
      await review.approve({ jobId: command.jobId, segmentId })
    }
    const fourth = await render.execute({ jobId: command.jobId, voices: fixture.voices })
    expect(fourth.job.state).toBe('completed')
    // MEASURED: 3 of 9 segments re-rendered, 6 reused.
    expect(fourth.generatedSegments).toBe(MIRA_SEGMENTS.length)
    expect(fourth.reusedSegments).toBe(TOTAL_SEGMENTS - MIRA_SEGMENTS.length)

    // The strongest form of the same measurement: what the real worker was actually asked to speak.
    const batches = await workerBatches(fixture.workerLog)
    expect(batches).toHaveLength(2)
    expect(batches[1]?.segmentIds.slice().sort()).toEqual(MIRA_SEGMENTS.slice().sort())

    // Direction ran once for the whole exercise. Re-rendering after review never re-directs, which
    // is what keeps a re-render attributable to the approval rather than to a fresh LLM pass.
    expect(fixture.extractor.extractions).toBe(1)
    expect(fixture.director.directed).toHaveLength(CHAPTER_LINES.length)
    expect(fixture.gate.acquisitions).toBe(fixture.gate.releases)
  }, 120_000)

  it('refuses a fallback segment with no persisted approval inside the real adapter itself', async () => {
    const fixture = await makeFixture()
    // The approval catalog is complete except for one segment, and it reaches the adapter through
    // exactly the seam a composition root uses. Nothing here can auto-approve: there is no policy,
    // flag or default on the factory or the adapter that renders an unapproved fallback segment.
    const direct = new DirectAudiobook({
      epubExtractor: fixture.extractor,
      directorModel: fixture.director,
      speechEngineFactory: createQwenSpeechEngineFactory(fixture.engine),
      audioAssembler: fixture.assembler,
      jobs: fixture.jobs,
    })
    const { book } = await direct.execute({
      jobId: 'job-engine-gate',
      epubPath: EPUB_PATH,
      epubSha256: SOURCE_HASH,
      voices: fixture.voices,
    })
    const review = new ReviewFallbackApprovals({
      jobs: fixture.jobs,
      approvals: fixture.approvals,
      now: () => DECIDED_AT,
    })
    const reconciled = await review.reconcile({ book, policy: 'pre-approve-book-fallback' })
    const withheld = MIRA_SEGMENTS[0]
    if (withheld === undefined) throw new Error('fixture speaker segment missing')
    const catalog = reconciled.approved.filter((record) => record.segmentId !== withheld)

    const factory = createQwenSpeechEngineFactory(fixture.engine)
    const adapter = await factory.create({ bookId: book.id, fallbackApprovals: catalog })
    expect(adapter).toBeInstanceOf(QwenApplicationSpeechEngine)
    const segment = book.chapters
      .flatMap((chapter) => chapter.segments)
      .find((candidate) => candidate.id === withheld)
    if (segment === undefined) throw new Error('fixture segment missing')

    await adapter.beginBatch()
    const failure = await adapter
      .render({
        segment,
        voice: fixture.voices.fallback,
        inputIdentity: '7'.repeat(64),
      })
      .then(() => undefined)
      .catch((error: unknown) => error)
    await adapter.endBatch()

    expect(failure).toBeInstanceOf(SpeechEngineError)
    expect((failure as SpeechEngineError).message).toContain('no explicit human approval')
    expect((failure as SpeechEngineError).segmentId).toBe(withheld)
    // Nothing was spoken for it: the refusal happened before the worker was handed the segment.
    const batches = await workerBatches(fixture.workerLog)
    expect(batches.flatMap((batch) => batch.segmentIds)).not.toContain(withheld)
  }, 120_000)

  it('stops before rendering when the policy requires an explicit decision for each speaker', async () => {
    const fixture = await makeFixture()
    const generate = new GenerateAudiobook({
      epubExtractor: fixture.extractor,
      directorModel: fixture.director,
      speechEngineFactory: createQwenSpeechEngineFactory(fixture.engine),
      audioAssembler: fixture.assembler,
      jobs: fixture.jobs,
      approvals: fixture.approvals,
      now: () => DECIDED_AT,
    })
    const command = {
      jobId: 'job-explicit-review',
      epubPath: EPUB_PATH,
      epubSha256: SOURCE_HASH,
      voices: fixture.voices,
      fallbackApprovalPolicy: 'require-explicit-review' as const,
    }

    const stopped = await generate
      .execute(command)
      .then(() => undefined)
      .catch((error: unknown) => error)
    expect(stopped).toBeInstanceOf(PendingFallbackReviewError)
    const pending = (stopped as PendingFallbackReviewError).pending
    expect(pending).toHaveLength(FALLBACK_SEGMENT_COUNT)
    // The review queue can be read: an excerpt of the exact line, the speaker, and the reason.
    expect(pending.every((item) => item.decision === 'pending')).toBe(true)
    expect(pending.every((item) => item.sourceTextExcerpt.length > 0)).toBe(true)
    expect(pending.map((item) => item.speakerId)).toEqual([
      null,
      'mira',
      'mira',
      'mira',
      'kestrel',
      null,
    ])

    // Awaiting review, not failed: nothing went wrong, and no audio was produced.
    const job = await fixture.jobs.findJob(command.jobId)
    expect(job?.state).toBe('awaiting_review')
    expect(job?.error).toBeNull()
    expect(await workerBatches(fixture.workerLog)).toHaveLength(0)
    expect(await fixture.approvals.listForBook(BOOK_ID)).toHaveLength(0)

    // Deciding each one through the review context lets the same script render with no re-direction.
    const review = new ReviewFallbackApprovals({
      jobs: fixture.jobs,
      approvals: fixture.approvals,
      now: () => DECIDED_AT,
    })
    for (const item of pending)
      await review.approve({ jobId: command.jobId, segmentId: item.segmentId })
    expect((await review.list(command.jobId)).every((item) => item.decision === 'approved')).toBe(
      true,
    )

    const rendered = await new RenderAudiobook({
      speechEngineFactory: createQwenSpeechEngineFactory(fixture.engine),
      audioAssembler: fixture.assembler,
      jobs: fixture.jobs,
      approvals: fixture.approvals,
    }).execute({ jobId: command.jobId, voices: fixture.voices })
    expect(rendered.job.state).toBe('completed')
    expect(rendered.generatedSegments).toBe(TOTAL_SEGMENTS)
    expect(fixture.director.directed).toHaveLength(CHAPTER_LINES.length)
  }, 120_000)
})
