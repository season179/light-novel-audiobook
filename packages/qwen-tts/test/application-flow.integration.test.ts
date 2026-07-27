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
  type DirectorModelFactory,
  type EpubExtractor,
  GenerateAudiobook,
  RenderAudiobook,
  ReviewDirection,
  ReviewFallbackApprovals,
  resolveReviewerIdentity,
  StaleFallbackCatalogError,
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
  SqliteDirectionApprovalRepository,
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

/**
 * Counts how many directors were constructed. A render-only review resume must construct none: with
 * Gemma, `release()` is terminal and the model owns GPU memory, so one built and abandoned leaks.
 */
class FixtureDirectorFactory implements DirectorModelFactory {
  readonly identity: string
  readonly created: FixtureDirector[] = []
  private readonly inner: FixtureDirector

  constructor(inner: FixtureDirector) {
    this.inner = inner
    this.identity = inner.identity
  }

  create(): FixtureDirector {
    this.created.push(this.inner)
    return this.inner
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
  quarantines = 0
  releases = 0

  async acquire(owner: GpuOwner, signal?: AbortSignal): Promise<GpuLease> {
    if (signal?.aborted) throw new Error('aborted')
    this.acquisitions += 1
    let released = false
    return {
      owner,
      lockFilePath: '/fixture/gpu.lock',
      quarantine: async () => {
        this.quarantines += 1
      },
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
  readonly db: DatabaseSync
  readonly jobs: SqliteJobRepository
  readonly approvals: SqliteFallbackApprovalRepository
  readonly directionApprovals: SqliteDirectionApprovalRepository
  readonly engine: QwenTtsSpeechEngine
  readonly gate: FixtureGpuGate
  readonly workerLog: string
  readonly voices: VoiceCast
  readonly extractor: FixtureExtractor
  readonly director: FixtureDirector
  readonly directorFactory: FixtureDirectorFactory
  readonly assembler: FixtureAssembler
}

const REVIEWER = resolveReviewerIdentity({ LNA_REVIEWER: 'local-reviewer' })

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

  const director = new FixtureDirector()
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
    db,
    jobs: new SqliteJobRepository(layout, db),
    approvals: new SqliteFallbackApprovalRepository(db),
    directionApprovals: new SqliteDirectionApprovalRepository(db),
    engine,
    gate,
    workerLog,
    voices: await castFromPinnedConfig(),
    extractor: new FixtureExtractor(),
    director,
    directorFactory: new FixtureDirectorFactory(director),
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
  it('approves nothing without an explicit human decision, then completes and re-renders only the speaker whose approval moved', async () => {
    const fixture = await makeFixture()
    const generate = new GenerateAudiobook({
      epubExtractor: fixture.extractor,
      directorModelFactory: fixture.directorFactory,
      speechEngineFactory: createQwenSpeechEngineFactory(fixture.engine),
      audioAssembler: fixture.assembler,
      jobs: fixture.jobs,
      approvals: fixture.approvals,
      now: () => DECIDED_AT,
    })
    const review = new ReviewFallbackApprovals({
      jobs: fixture.jobs,
      approvals: fixture.approvals,
      now: () => DECIDED_AT,
    })
    const directionReview = new ReviewDirection({
      jobs: fixture.jobs,
      approvals: fixture.directionApprovals,
      now: () => DECIDED_AT,
    })
    const render = new RenderAudiobook({
      speechEngineFactory: createQwenSpeechEngineFactory(fixture.engine),
      audioAssembler: fixture.assembler,
      jobs: fixture.jobs,
      approvals: fixture.approvals,
      directionApprovals: fixture.directionApprovals,
    })
    const command = {
      jobId: 'job-issue-45',
      epubPath: EPUB_PATH,
      epubSha256: SOURCE_HASH,
      voices: fixture.voices,
    }

    // ---- Run 0: no human decision exists, so nothing is approved and nothing renders. ----------
    // The command has no approval-policy field at all, so this is not "the safe default" — it is the
    // only behaviour available. Round 2's HIGH was that omitting a policy silently approved the book.
    const stopped = await generate.execute(command)
    expect(stopped.job.state).toBe('awaiting_review')
    expect(stopped.pendingFallbackApprovals).toHaveLength(FALLBACK_SEGMENT_COUNT)
    expect((await fixture.approvals.readCatalog(BOOK_ID)).approvals).toEqual([])
    expect(await workerBatches(fixture.workerLog)).toHaveLength(0)
    expect((await fixture.jobs.findJob(command.jobId))?.state).toBe('awaiting_review')
    // Direction ran once and its director was constructed once and released.
    expect(fixture.directorFactory.created).toHaveLength(1)
    expect(fixture.director.released).toBe(1)

    // ---- Run 1: one explicit book-wide human decision, then the book completes. ----------------
    const granted = await review.grantBookFallback({ jobId: command.jobId, decidedBy: REVIEWER })
    expect(granted.created).toHaveLength(FALLBACK_SEGMENT_COUNT)
    expect(granted.grant?.decidedBy).toBe(REVIEWER)

    await directionReview.confirm({ jobId: command.jobId, decidedBy: REVIEWER })
    const first = await render.execute({ jobId: command.jobId, voices: fixture.voices })
    expect(first.job.state).toBe('completed')
    expect(first.generatedSegments).toBe(TOTAL_SEGMENTS)
    expect(first.reusedSegments).toBe(0)

    // No director was built for the render-only resume: the count is still 1 from run 0.
    expect(fixture.directorFactory.created).toHaveLength(1)
    expect(fixture.extractor.extractions).toBe(1)
    expect(fixture.director.directed).toHaveLength(CHAPTER_LINES.length)

    // Per-segment records, not one blanket approval, every identity distinct, every one attributed.
    const stored = (await fixture.approvals.readCatalog(BOOK_ID)).approvals
    expect(stored).toHaveLength(FALLBACK_SEGMENT_COUNT)
    expect(new Set(stored.map((record) => record.approvalId)).size).toBe(FALLBACK_SEGMENT_COUNT)
    expect(new Set(stored.map((record) => record.approvalSha256)).size).toBe(FALLBACK_SEGMENT_COUNT)
    expect(stored.every((record) => record.decidedBy === REVIEWER)).toBe(true)
    expect(stored.every((record) => record.grantId === granted.grant?.grantId)).toBe(true)
    expect(stored.every((record) => record.voiceProfileId === 'cast-fallback')).toBe(true)
    expect(
      stored
        .filter((record) => record.fallbackReason === 'missing_speaker_voice')
        .map((record) => record.speakerId)
        .sort(),
    ).toEqual(['kestrel', 'mira', 'mira', 'mira'])

    // The real adapter bound each decision into that segment's own render manifest.
    const engineAudio = join(fixture.workspaceRoot, '..', 'engine', 'audio')
    for (const record of stored) {
      const manifest = JSON.parse(
        await readFile(join(engineAudio, `${record.segmentId}.render.json`), 'utf8'),
      ) as { renderIdentity: { voice: { fallbackApproval: unknown } } }
      expect(manifest.renderIdentity.voice.fallbackApproval).toEqual({
        approvalId: record.approvalId,
        approvalSha256: record.approvalSha256,
      })
    }

    // ---- Run 2: nothing changed, so nothing re-renders. --------------------------------------
    // Load-bearing for the two below: unless reuse demonstrably engages here, "only one speaker
    // re-rendered" would also be true of a run that re-rendered nothing at all.
    const reopened = await fixture.jobs.findJob(command.jobId)
    if (reopened === undefined) throw new Error('job vanished')
    reopened.reopenForReview()
    await fixture.jobs.saveJob(reopened)
    const second = await render.execute({ jobId: command.jobId, voices: fixture.voices })
    expect(second.generatedSegments).toBe(0)
    expect(second.reusedSegments).toBe(TOTAL_SEGMENTS)
    expect(await workerBatches(fixture.workerLog)).toHaveLength(1)
    // Still no second director: two review resumes, one director.
    expect(fixture.directorFactory.created).toHaveLength(1)

    // ---- Run 3: withdraw every approval for `mira` only. -------------------------------------
    const later = new ReviewFallbackApprovals({
      jobs: fixture.jobs,
      approvals: fixture.approvals,
      now: () => RE_DECIDED_AT,
    })
    for (const segmentId of MIRA_SEGMENTS) {
      expect(await later.revoke({ jobId: command.jobId, segmentId, decidedBy: REVIEWER })).toBe(
        true,
      )
    }
    const afterRevoke = await fixture.approvals.readCatalog(BOOK_ID)
    expect(afterRevoke.approvals).toHaveLength(FALLBACK_SEGMENT_COUNT - MIRA_SEGMENTS.length)
    // Recorded as exclusions, so the still-live book-wide grant cannot silently re-create them.
    expect(afterRevoke.exclusions.map((item) => item.segmentId).sort()).toEqual(
      MIRA_SEGMENTS.slice().sort(),
    )
    expect(afterRevoke.grant).not.toBeUndefined()
    const reopenedByRevoke = await fixture.jobs.findJob(command.jobId)
    expect(reopenedByRevoke?.state).toBe('awaiting_review')
    expect(reopenedByRevoke?.catalogRevision).toBeNull()

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
      await later.approve({ jobId: command.jobId, segmentId, decidedBy: REVIEWER })
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

    // One extraction and one direction for the whole exercise, across five generation attempts.
    expect(fixture.extractor.extractions).toBe(1)
    expect(fixture.directorFactory.created).toHaveLength(1)
    expect(fixture.gate.acquisitions).toBe(fixture.gate.releases)
  }, 180_000)

  it('refuses a fallback segment with no persisted approval inside the real adapter itself', async () => {
    const fixture = await makeFixture()
    // The approval catalog is complete except for one segment, and it reaches the adapter through
    // exactly the seam a composition root uses. Nothing here can auto-approve: there is no policy,
    // flag or default on the factory or the adapter that renders an unapproved fallback segment.
    const direct = new DirectAudiobook({
      epubExtractor: fixture.extractor,
      directorModelFactory: fixture.directorFactory,
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
    const reconciled = await review.grantBookFallback({
      jobId: 'job-engine-gate',
      decidedBy: REVIEWER,
    })
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
      .render({ segment, voice: fixture.voices.fallback, inputIdentity: '7'.repeat(64) })
      .then(() => undefined)
      .catch((error: unknown) => error)
    await adapter.endBatch()

    expect(failure).toBeInstanceOf(SpeechEngineError)
    expect((failure as SpeechEngineError).message).toContain('no explicit human approval')
    expect((failure as SpeechEngineError).segmentId).toBe(withheld)
    // Nothing was spoken for it: the refusal happened before the worker was handed the segment.
    const batches = await workerBatches(fixture.workerLog)
    expect(batches.flatMap((batch) => batch.segmentIds)).not.toContain(withheld)
  }, 180_000)

  it('refuses to publish a render whose approval catalog moved while it was in flight', async () => {
    const fixture = await makeFixture()
    const direct = new DirectAudiobook({
      epubExtractor: fixture.extractor,
      directorModelFactory: fixture.directorFactory,
      speechEngineFactory: createQwenSpeechEngineFactory(fixture.engine),
      audioAssembler: fixture.assembler,
      jobs: fixture.jobs,
    })
    await direct.execute({
      jobId: 'job-catalog-race',
      epubPath: EPUB_PATH,
      epubSha256: SOURCE_HASH,
      voices: fixture.voices,
    })
    const review = new ReviewFallbackApprovals({
      jobs: fixture.jobs,
      approvals: fixture.approvals,
      now: () => DECIDED_AT,
    })
    await review.grantBookFallback({ jobId: 'job-catalog-race', decidedBy: REVIEWER })
    await new ReviewDirection({
      jobs: fixture.jobs,
      approvals: fixture.directionApprovals,
      now: () => DECIDED_AT,
    }).confirm({ jobId: 'job-catalog-race', decidedBy: REVIEWER })

    // A decision that lands after the render captured its catalog. The render cannot see it — that
    // is the point — so the barrier is the revision it claimed, re-checked before anything is
    // published. Driven through the repository directly because `ReviewFallbackApprovals` refuses to
    // mutate a running job at all; this simulates the residual window before that guard applies.
    const racing = new (class extends SqliteFallbackApprovalRepository {
      override async readCatalog(bookId: string) {
        this.reads += 1
        if (this.reads === 3) {
          const victim = MIRA_SEGMENTS[0]
          if (victim !== undefined) {
            await super.revoke(bookId, victim, {
              reason: 'human-withdrawal',
              decidedBy: 'another-reviewer',
              decidedAt: RE_DECIDED_AT.toISOString(),
            })
          }
        }
        return super.readCatalog(bookId)
      }
      reads = 0
    })(fixture.db)

    const render = new RenderAudiobook({
      speechEngineFactory: createQwenSpeechEngineFactory(fixture.engine),
      audioAssembler: fixture.assembler,
      jobs: fixture.jobs,
      approvals: racing,
      directionApprovals: fixture.directionApprovals,
    })
    const failure = await render
      .execute({ jobId: 'job-catalog-race', voices: fixture.voices })
      .then(() => undefined)
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(StaleFallbackCatalogError)
    // Nothing was published: no output, and the job records the failure rather than completing.
    const job = await fixture.jobs.findJob('job-catalog-race')
    expect(job?.state).toBe('failed')
    expect(job?.state).toBe('failed')
    expect(fixture.assembler.assemblies).toBe(0)
  }, 180_000)
})
