import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  type CompletedSegmentAudio,
  createRenderInputIdentity,
} from '@light-novel-audiobook/application'
import {
  AudiobookJob,
  Book,
  Chapter,
  type DirectedSegment,
  DomainError,
  ExactSourceCoverage,
  OutputVersion,
  type Segment,
  SourcePassage,
  StableIds,
  VoiceCast,
  VoiceProfile,
} from '@light-novel-audiobook/domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  layoutFor,
  openWorkspace,
  SCHEMA_VERSION,
  SqliteJobRepository,
  sha256OfFile,
  type WorkspaceLayout,
  wavPathFor,
} from '../src/index.js'

const SOURCE_HASH = 'a'.repeat(64)
const BOOK_ID = StableIds.book(SOURCE_HASH)
const CHAPTER_ID = StableIds.chapter(BOOK_ID, 1)
const PASSAGE_ID = StableIds.passage(CHAPTER_ID, 1)
const COMMAND_IDENTITY = 'd'.repeat(64)
const SPEECH_ENGINE_IDENTITY = 'fake-qwen:model-revision-1:settings-1'

const delivery = {
  emotion: 'neutral',
  pace: 'normal',
  volume: 'normal',
  pauseAfterMs: 0,
} as const

const voice = (
  id: string,
  role: 'narrator' | 'character' | 'fallback',
  speakerId: string | null,
  revision = 1,
): VoiceProfile =>
  new VoiceProfile({
    id,
    displayName: id,
    role,
    speakerId,
    syntheticSpeaker: role === 'narrator' ? 'Aiden' : 'Ryan',
    instruction: `${id} restrained delivery revision ${revision}`,
    seed: 42,
    revision,
  })

const makeCast = (aliceRevision = 1): VoiceCast =>
  new VoiceCast(
    voice('narrator-calm', 'narrator', null),
    voice('fallback-dialogue', 'fallback', null),
    [voice('alice-voice', 'character', 'alice', aliceRevision)],
  )

// One chapter / one passage split into narration, dialogue(alice), narration.
const makeBook = (aliceRevision = 1): { book: Book; cast: VoiceCast } => {
  const cast = makeCast(aliceRevision)
  const chapter = new Chapter({
    id: CHAPTER_ID,
    bookId: BOOK_ID,
    position: 1,
    title: 'Dawn',
    sourcePassages: [
      new SourcePassage({
        id: PASSAGE_ID,
        chapterId: CHAPTER_ID,
        sourceText: 'Dawn broke. \u201cHi,\u201d she said.',
      }),
    ],
  })
  const directed: readonly DirectedSegment[] = [
    {
      sourcePassageId: PASSAGE_ID,
      sourceText: 'Dawn broke. ',
      kind: 'narration',
      speakerId: null,
      confidence: 1,
      delivery,
    },
    {
      sourcePassageId: PASSAGE_ID,
      sourceText: '\u201cHi,\u201d',
      kind: 'dialogue',
      speakerId: 'alice',
      confidence: 0.95,
      delivery: { ...delivery, emotion: 'warm' },
    },
    {
      sourcePassageId: PASSAGE_ID,
      sourceText: ' she said.',
      kind: 'narration',
      speakerId: null,
      confidence: 1,
      delivery,
    },
  ]
  const segments = ExactSourceCoverage.createSegments(chapter, directed)
  chapter.submitForReview(segments)
  for (const segment of segments) {
    segment.assignVoice(cast.resolve(segment).assignment)
  }
  chapter.approve()
  const book = new Book({
    id: BOOK_ID,
    title: 'Resume Story',
    author: 'Test Author',
    coverPath: null,
    source: { epubPath: '/uploads/resume.epub', sha256: SOURCE_HASH },
    chapters: [chapter],
  })
  return { book, cast }
}

const makePlainBook = (count: number): Book => {
  const fragments = Array.from({ length: count }, (_, index) => `line ${index + 1}. `)
  const chapter = new Chapter({
    id: CHAPTER_ID,
    bookId: BOOK_ID,
    position: 1,
    title: 'Plain',
    sourcePassages: [
      new SourcePassage({
        id: PASSAGE_ID,
        chapterId: CHAPTER_ID,
        sourceText: fragments.join(''),
      }),
    ],
  })
  const directed: readonly DirectedSegment[] = fragments.map((sourceText) => ({
    sourcePassageId: PASSAGE_ID,
    sourceText,
    kind: 'narration',
    speakerId: null,
    confidence: 1,
    delivery,
  }))
  chapter.submitForReview(ExactSourceCoverage.createSegments(chapter, directed))
  return new Book({
    id: BOOK_ID,
    title: 'Plain Book',
    author: null,
    coverPath: null,
    source: { epubPath: '/uploads/plain.epub', sha256: SOURCE_HASH },
    chapters: [chapter],
  })
}

/** A distinct book -- different source hash, so a different book id -- under a chosen title. */
const makeTitledBook = (sourceHash: string, title: string): Book => {
  const bookId = StableIds.book(sourceHash)
  const chapterId = StableIds.chapter(bookId, 1)
  return new Book({
    id: bookId,
    title,
    author: null,
    coverPath: null,
    source: { epubPath: `/uploads/${sourceHash.slice(0, 8)}.epub`, sha256: sourceHash },
    chapters: [
      new Chapter({
        id: chapterId,
        bookId,
        position: 1,
        title: 'One',
        sourcePassages: [
          new SourcePassage({
            id: StableIds.passage(chapterId, 1),
            chapterId,
            sourceText: 'Only passage.',
          }),
        ],
      }),
    ],
  })
}

const segmentsOf = (book: Book): readonly Segment[] => book.chapters[0]?.segments ?? []

const identityFor = (
  segment: Segment,
  cast: VoiceCast,
  engine = SPEECH_ENGINE_IDENTITY,
): string => {
  const assignment = segment.voiceAssignment
  if (!assignment) throw new Error(`segment ${segment.id} has no voice assignment`)
  return createRenderInputIdentity(segment, cast.profile(assignment.voiceProfileId), engine)
}

const writeArtifact = (
  layout: WorkspaceLayout,
  segmentId: string,
  inputIdentity: string,
  payload: Buffer,
): CompletedSegmentAudio => {
  const wavPath = wavPathFor(layout, segmentId, inputIdentity)
  writeFileSync(wavPath, payload)
  return {
    segmentId,
    inputIdentity,
    wavPath,
    sha256: sha256OfFile(wavPath),
    byteLength: payload.length,
  }
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms)
  })

const waitForFile = async (path: string, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for file: ${path}`)
    await delay(10)
  }
}

interface Harness {
  readonly layout: WorkspaceLayout
  readonly repo: SqliteJobRepository
  readonly db: DatabaseSync
  reopen(): void
}

describe('SqliteJobRepository contract (issue #27)', () => {
  const createdRoots: string[] = []
  let harness: Harness

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'lna-persist-'))
    createdRoots.push(root)
    const layout = layoutFor(root)
    let db = openWorkspace(layout)
    let repo = new SqliteJobRepository(layout, db)
    harness = {
      layout,
      get repo() {
        return repo
      },
      get db() {
        return db
      },
      reopen() {
        db.close()
        db = openWorkspace(layout)
        repo = new SqliteJobRepository(layout, db)
      },
    }
  })

  afterEach(() => {
    try {
      harness.db.close()
    } catch {
      // Database may already be closed by reopen(); ignore.
    }
    for (const root of createdRoots) rmSync(root, { recursive: true, force: true })
    createdRoots.length = 0
  })

  it('retries saveJob with a fresh transaction when another process holds the writer lock', async () => {
    const ready = join(harness.layout.root, 'writer-locked')
    const child = join(dirname(fileURLToPath(import.meta.url)), 'hold-write-lock-child.ts')
    const run = promisify(execFile)
    const locker = run(
      process.execPath,
      ['--import', 'tsx', child, harness.layout.dbPath, ready, '500'],
      { maxBuffer: 1 << 20 },
    )

    await waitForFile(ready, 5000)
    // Make the first BEGIN IMMEDIATE lose quickly, so the repository's outer retry -- rather
    // than SQLite's own five-second timeout -- is what lets this save survive contention.
    harness.db.exec('PRAGMA busy_timeout = 50')
    const job = new AudiobookJob('job-busy-retry')

    try {
      await harness.repo.saveJob(job)
    } finally {
      await locker
    }

    expect(await harness.repo.findJob(job.id)).toBeDefined()
  })

  it('stores completed output separately from public job state across restart and reopen', async () => {
    const job = new AudiobookJob('job-separated-output')
    job.bindCommand(COMMAND_IDENTITY)
    job.start()
    job.attachBook(BOOK_ID)
    job.beginDirection(1, 1)
    job.recordDirectionProgress(CHAPTER_ID, 1, 1, 'Directed chapter 1 of 1')
    job.beginRendering(1)
    job.recordSegmentCompleted('segment-1')
    job.beginAssembly()
    const output = {
      version: new OutputVersion(7),
      m4bPath: '/workspace/private-v007.m4b',
      chapters: [{ chapterId: CHAPTER_ID, path: '/workspace/private-v007-ch01.flac' }],
    }
    job.complete(output, 11)
    await harness.repo.saveCompletedJob(job, output)

    const storedJob = await harness.repo.findJob(job.id)
    expect(storedJob?.state).toBe('completed')
    expect(Reflect.get(storedJob as object, 'completedOutput')).toBeUndefined()
    expect(JSON.stringify(storedJob?.snapshot())).not.toContain(output.m4bPath)
    expect((await harness.repo.findCompletedOutput(job.id))?.m4bPath).toBe(output.m4bPath)

    harness.reopen()
    const restarted = await harness.repo.findJob(job.id)
    expect(restarted?.state).toBe('completed')
    expect((await harness.repo.findCompletedOutput(job.id))?.version.value).toBe(7)

    restarted?.reopenForReview()
    if (restarted === undefined) throw new Error('completed job disappeared after restart')
    await harness.repo.saveJob(restarted)
    expect(await harness.repo.findCompletedOutput(job.id)).toBeUndefined()
  })

  it('resumes a restarted job by reusing its previously completed segment audio', async () => {
    const { book, cast } = makeBook()
    const [segment] = segmentsOf(book)
    if (!segment) throw new Error('fixture segment missing')
    const inputIdentity = identityFor(segment, cast)

    const job = new AudiobookJob('job-resume')
    job.bindCommand(COMMAND_IDENTITY)
    job.start()
    job.attachBook(book.id)
    await harness.repo.saveBook(book)
    await harness.repo.saveJob(job)

    const artifact = writeArtifact(
      harness.layout,
      segment.id,
      inputIdentity,
      Buffer.from('resume-payload'),
    )
    await harness.repo.saveCompletedSegment(artifact)

    // GenerateAudiobook re-saves the book after rendering each chapter and again
    // after job.complete(), so a completed artifact must survive saveBook.
    await harness.repo.saveBook(book)

    // Simulate a process restart over the same database and workspace.
    harness.reopen()

    const found = await harness.repo.findJob('job-resume')
    if (!found) throw new Error('job should have been persisted')
    expect(found.state).toBe('running')
    expect(found.stage).toBe('extracting')
    expect(found.bookId).toBe(book.id)
    expect(found.commandIdentity).toBe(COMMAND_IDENTITY)

    const reused = await harness.repo.findReusableSegment({
      segmentId: segment.id,
      inputIdentity,
    })
    if (!reused) throw new Error('completed segment should be reusable after restart')
    expect(reused.segmentId).toBe(segment.id)
    expect(reused.inputIdentity).toBe(inputIdentity)
    expect(reused.byteLength).toBe(artifact.byteLength)
    expect(reused.sha256).toBe(artifact.sha256)
    expect(sha256OfFile(reused.wavPath)).toBe(artifact.sha256)

    // A different identity for the same segment is not reused.
    expect(
      await harness.repo.findReusableSegment({
        segmentId: segment.id,
        inputIdentity: createHash('sha256').update('other').digest('hex'),
      }),
    ).toBeUndefined()
  })

  it('invalidates only the segment whose voice input changed and reuses its siblings', async () => {
    const { book, cast: castV1 } = makeBook(1)
    const [seg0, seg1, seg2] = segmentsOf(book)
    if (!seg0 || !seg1 || !seg2) throw new Error('fixture segments missing')

    await harness.repo.saveBook(book)
    for (const segment of [seg0, seg1, seg2]) {
      const identity = identityFor(segment, castV1)
      await harness.repo.saveCompletedSegment(
        writeArtifact(harness.layout, segment.id, identity, Buffer.from(`${segment.id}-v1`)),
      )
      // The real caller re-saves the book while segments are being completed.
      await harness.repo.saveBook(book)
    }

    harness.reopen()

    // Inputs change: only alice's voice revision bumps, affecting the dialogue segment.
    const castV2 = makeCast(2)
    const seg0Identity = identityFor(seg0, castV1)
    const seg2Identity = identityFor(seg2, castV1)
    const seg1IdentityV1 = identityFor(seg1, castV1)
    const seg1IdentityV2 = identityFor(seg1, castV2)

    // Sibling narration segments keep their identity and stay reusable.
    expect(identityFor(seg0, castV2)).toBe(seg0Identity)
    expect(identityFor(seg2, castV2)).toBe(seg2Identity)
    expect(
      await harness.repo.findReusableSegment({ segmentId: seg0.id, inputIdentity: seg0Identity }),
    ).toBeDefined()
    expect(
      await harness.repo.findReusableSegment({ segmentId: seg2.id, inputIdentity: seg2Identity }),
    ).toBeDefined()

    // The changed dialogue segment is not reusable under its new identity.
    expect(seg1IdentityV1).not.toBe(seg1IdentityV2)
    expect(
      await harness.repo.findReusableSegment({
        segmentId: seg1.id,
        inputIdentity: seg1IdentityV2,
      }),
    ).toBeUndefined()
  })

  it('treats missing, truncated, or corrupt WAV files as not completed instead of reusing them', async () => {
    const book = makePlainBook(4)
    const [good, missing, truncated, corrupt] = segmentsOf(book)
    if (!good || !missing || !truncated || !corrupt) {
      throw new Error('fixture segments missing')
    }
    await harness.repo.saveBook(book)

    const hex = (label: string) => createHash('sha256').update(label, 'utf8').digest('hex')

    const goodArtifact = writeArtifact(
      harness.layout,
      good.id,
      hex('good'),
      Buffer.from('good-bytes'),
    )
    await harness.repo.saveCompletedSegment(goodArtifact)

    const missingArtifact = writeArtifact(
      harness.layout,
      missing.id,
      hex('missing'),
      Buffer.from('missing-bytes'),
    )
    await harness.repo.saveCompletedSegment(missingArtifact)
    rmSync(missingArtifact.wavPath, { force: true })

    const truncatedArtifact = writeArtifact(
      harness.layout,
      truncated.id,
      hex('truncated'),
      Buffer.from('twelve-bytes'),
    )
    await harness.repo.saveCompletedSegment(truncatedArtifact)
    writeFileSync(truncatedArtifact.wavPath, Buffer.from('short'))

    const corruptArtifact = writeArtifact(
      harness.layout,
      corrupt.id,
      hex('corrupt'),
      Buffer.from('AAAAAAAA'),
    )
    await harness.repo.saveCompletedSegment(corruptArtifact)
    writeFileSync(corruptArtifact.wavPath, Buffer.from('BBBBBBBB'))

    // Re-saving book metadata must not disturb the recorded artifacts.
    await harness.repo.saveBook(book)

    // A healthy artifact is still reused.
    expect(
      await harness.repo.findReusableSegment({
        segmentId: good.id,
        inputIdentity: goodArtifact.inputIdentity,
      }),
    ).toBeDefined()

    // Missing, truncated, and corrupt artifacts are all rejected.
    expect(
      await harness.repo.findReusableSegment({
        segmentId: missing.id,
        inputIdentity: missingArtifact.inputIdentity,
      }),
    ).toBeUndefined()
    expect(
      await harness.repo.findReusableSegment({
        segmentId: truncated.id,
        inputIdentity: truncatedArtifact.inputIdentity,
      }),
    ).toBeUndefined()
    expect(
      await harness.repo.findReusableSegment({
        segmentId: corrupt.id,
        inputIdentity: corruptArtifact.inputIdentity,
      }),
    ).toBeUndefined()
  })

  it('recovers an abandoned job left mid-flight and keeps its completed segments reusable', async () => {
    const { book, cast } = makeBook()
    const [seg0, seg1, seg2] = segmentsOf(book)
    if (!seg0 || !seg1 || !seg2) throw new Error('fixture segments missing')

    const job = new AudiobookJob('job-abandoned')
    job.bindCommand(COMMAND_IDENTITY)
    job.start()
    job.attachBook(book.id)
    const totalPassages = book.chapters.reduce(
      (total, chapter) => total + chapter.sourcePassages.length,
      0,
    )
    job.beginDirection(book.chapters.length, totalPassages)
    job.recordDirectionProgress(
      book.chapters.at(-1)?.id ?? CHAPTER_ID,
      book.chapters.length,
      totalPassages,
      `Directed chapter ${book.chapters.length} of ${book.chapters.length}`,
    )
    job.beginRendering(3)
    await harness.repo.saveBook(book)
    await harness.repo.saveJob(job)

    // Two segments finish before the simulated crash; the third stays pending.
    const artifact0 = writeArtifact(
      harness.layout,
      seg0.id,
      identityFor(seg0, cast),
      Buffer.from('a0'),
    )
    const artifact1 = writeArtifact(
      harness.layout,
      seg1.id,
      identityFor(seg1, cast),
      Buffer.from('a1'),
    )
    await harness.repo.saveCompletedSegment(artifact0)
    job.recordSegmentCompleted(seg0.id)
    await harness.repo.saveJob(job)
    await harness.repo.saveBook(book)
    await harness.repo.saveCompletedSegment(artifact1)
    job.recordSegmentCompleted(seg1.id)
    await harness.repo.saveBook(book)

    // The worker disappears mid-flight, leaving the job in an abandoned state.
    job.markAbandoned()
    await harness.repo.saveJob(job)

    // A fresh process takes over the same workspace.
    harness.reopen()
    const recovered = await harness.repo.findJob('job-abandoned')
    if (!recovered) throw new Error('abandoned job should have been persisted')
    expect(recovered.state).toBe('abandoned')
    expect(recovered.progress).toMatchObject({ completedSegments: 2, totalSegments: 3 })

    recovered.recoverAbandoned()
    expect(recovered.state).toBe('running')
    expect(recovered.stage).toBe('extracting')
    await harness.repo.saveJob(recovered)

    // Completed audio survives recovery and stays reusable.
    expect(
      await harness.repo.findReusableSegment({
        segmentId: seg0.id,
        inputIdentity: artifact0.inputIdentity,
      }),
    ).toBeDefined()
    expect(
      await harness.repo.findReusableSegment({
        segmentId: seg1.id,
        inputIdentity: artifact1.inputIdentity,
      }),
    ).toBeDefined()
    // The never-completed segment is still missing.
    expect(
      await harness.repo.findReusableSegment({
        segmentId: seg2.id,
        inputIdentity: identityFor(seg2, cast),
      }),
    ).toBeUndefined()
  })

  it('never hands out the same output version twice, even across a restart', async () => {
    const { book } = makeBook()
    await harness.repo.saveBook(book)

    const r1 = await harness.repo.reserveNextOutput(book)
    await harness.repo.saveBook(book)
    const r2 = await harness.repo.reserveNextOutput(book)
    await harness.repo.saveBook(book)
    const r3 = await harness.repo.reserveNextOutput(book)
    expect([r1.version.value, r2.version.value, r3.version.value]).toEqual([1, 2, 3])
    const paths = [r1.m4bPath, r2.m4bPath, r3.m4bPath]
    expect(new Set(paths).size).toBe(3)

    // Restart: the persisted reservation counter must keep climbing.
    await harness.repo.saveBook(book)
    harness.reopen()
    const r4 = await harness.repo.reserveNextOutput(book)
    expect(r4.version.value).toBe(4)
    expect(paths).not.toContain(r4.m4bPath)

    const allVersions = [r1, r2, r3, r4].map((reservation) => reservation.version.value)
    expect(new Set(allVersions).size).toBe(allVersions.length)
  })

  it('reserves the next free version instead of overwriting an existing audiobook file', async () => {
    const { book } = makeBook()
    await harness.repo.saveBook(book)
    // outputBaseName('Resume Story') === 'resume-story'
    const existingPath = join(harness.layout.outputDir, 'resume-story-v001.m4b')
    writeFileSync(existingPath, Buffer.from('existing-audiobook'))

    const reservation = await harness.repo.reserveNextOutput(book)
    expect(reservation.version.value).toBe(2)
    expect(reservation.m4bPath).not.toBe(existingPath)
    expect(reservation.m4bPath.endsWith('resume-story-v002.m4b')).toBe(true)

    // The pre-existing v001 file is left untouched.
    expect(readFileSync(existingPath, 'utf8')).toBe('existing-audiobook')
  })

  // Regression (issue #27 review, F1): GenerateAudiobook calls saveBook six times per run,
  // interleaved with saveCompletedSegment. Re-saving book metadata must never drop the
  // reuse ledger, or a resumed book re-renders from scratch.
  it('keeps completed segment audio reusable when saveBook runs after saveCompletedSegment', async () => {
    const { book, cast } = makeBook()
    const [seg0, seg1] = segmentsOf(book)
    if (!seg0 || !seg1) throw new Error('fixture segments missing')
    const identity0 = identityFor(seg0, cast)
    const identity1 = identityFor(seg1, cast)

    await harness.repo.saveBook(book)

    const artifact0 = writeArtifact(harness.layout, seg0.id, identity0, Buffer.from('chapter-1-a'))
    await harness.repo.saveCompletedSegment(artifact0)

    // The exact ordering of generate-audiobook.ts:260 / :290 — the book is re-saved
    // between rendering one segment and reading back the next.
    await harness.repo.saveBook(book)

    const reused0 = await harness.repo.findReusableSegment({
      segmentId: seg0.id,
      inputIdentity: identity0,
    })
    if (!reused0) throw new Error('artifact saved before saveBook must remain reusable')
    expect(reused0.sha256).toBe(artifact0.sha256)
    expect(reused0.byteLength).toBe(artifact0.byteLength)

    // A second segment completes, then the book is saved twice more (chapter end + job.complete).
    const artifact1 = writeArtifact(harness.layout, seg1.id, identity1, Buffer.from('chapter-1-b'))
    await harness.repo.saveCompletedSegment(artifact1)
    await harness.repo.saveBook(book)
    await harness.repo.saveBook(book)

    const artifactRows = harness.db.prepare('SELECT COUNT(*) AS n FROM artifacts').get() as {
      n: number
    }
    expect(artifactRows.n).toBe(2)

    // And they are still reusable after a process restart.
    harness.reopen()
    expect(
      await harness.repo.findReusableSegment({ segmentId: seg0.id, inputIdentity: identity0 }),
    ).toBeDefined()
    expect(
      await harness.repo.findReusableSegment({ segmentId: seg1.id, inputIdentity: identity1 }),
    ).toBeDefined()
  })

  // Regression (issue #27 review, F2): a reservation is an append-only claim ledger.
  // Re-saving book metadata must never delete a claim, or the same version — and the
  // same .m4b path — is handed out twice and a finished audiobook is overwritten.
  it('keeps climbing output versions when saveBook runs between two reservations', async () => {
    const { book } = makeBook()
    await harness.repo.saveBook(book)

    const first = await harness.repo.reserveNextOutput(book)
    expect(first.version.value).toBe(1)
    expect(first.m4bPath.endsWith('resume-story-v001.m4b')).toBe(true)

    // generate-audiobook.ts:159 saves the book after job.complete(output); a crash-and-retry
    // run then saves it again at :132 before reserving. Neither may reset the ledger.
    await harness.repo.saveBook(book)

    const second = await harness.repo.reserveNextOutput(book)
    expect(second.version.value).toBe(2)
    expect(second.m4bPath).not.toBe(first.m4bPath)
    expect(second.m4bPath.endsWith('resume-story-v002.m4b')).toBe(true)

    // Chapter paths must differ too — the assembler writes chapter masters there.
    const firstChapterPaths = first.chapters.map((chapter) => chapter.path)
    for (const chapter of second.chapters) {
      expect(firstChapterPaths).not.toContain(chapter.path)
    }

    // Both claims are still on record, so a third run cannot reuse either.
    const reservationRows = harness.db
      .prepare('SELECT COUNT(*) AS n FROM output_reservations WHERE book_id = ?')
      .get(book.id) as { n: number }
    expect(reservationRows.n).toBe(2)

    await harness.repo.saveBook(book)
    const third = await harness.repo.reserveNextOutput(book)
    expect(third.version.value).toBe(3)
  })

  // The assembler (#32) resolves the paths it is handed rather than rejecting bad ones, so a
  // relative or non-canonical path would be silently rewritten: the book encodes somewhere else
  // and GenerateAudiobook.validateOutput then fails the run on an exact path compare, after the
  // whole encode, leaving files that wedge every retry.
  it('reserves only absolute, canonical paths inside the workspace', async () => {
    const { book } = makeBook()
    await harness.repo.saveBook(book)
    const reservation = await harness.repo.reserveNextOutput(book)

    const paths = [reservation.m4bPath, ...reservation.chapters.map((chapter) => chapter.path)]
    expect(paths.length).toBe(2)
    for (const path of paths) {
      expect(isAbsolute(path)).toBe(true)
      expect(resolve(path)).toBe(path)
      expect(path.startsWith(`${harness.layout.root}${sep}`)).toBe(true)
      expect(path).not.toContain(`${sep}${sep}`)
      expect(path.split(sep)).not.toContain('..')
      expect(path.split(sep)).not.toContain('.')
    }
  })

  it('refuses to reserve an output path that would escape the workspace', async () => {
    const escapingId = `${CHAPTER_ID}/../../../../escape`
    const escaping = new Chapter({
      id: escapingId,
      bookId: BOOK_ID,
      position: 1,
      title: 'Escape',
      sourcePassages: [
        new SourcePassage({
          id: `${escapingId}-p000001`,
          chapterId: escapingId,
          sourceText: 'Escaped.',
        }),
      ],
    })
    const book = new Book({
      id: BOOK_ID,
      title: 'Escape Story',
      author: null,
      coverPath: null,
      source: { epubPath: '/uploads/escape.epub', sha256: SOURCE_HASH },
      chapters: [escaping],
    })

    await expect(harness.repo.reserveNextOutput(book)).rejects.toBeInstanceOf(DomainError)
    // Nothing was claimed, so no half-reservation is left behind.
    const rows = harness.db
      .prepare('SELECT COUNT(*) AS n FROM output_reservations WHERE book_id = ?')
      .get(book.id) as { n: number }
    expect(rows.n).toBe(0)
  })

  // F6: findJob runs before the use case has a job to record a failure on, so a raw SyntaxError
  // would make the job permanently unopenable with no signal about why.
  it('reports a corrupt job snapshot as a domain error instead of a parser error', async () => {
    harness.db
      .prepare('INSERT INTO jobs (id, snapshot_json) VALUES (?, ?)')
      .run('job-corrupt', '{"id":"job-corrupt","state":"run')

    await expect(harness.repo.findJob('job-corrupt')).rejects.toBeInstanceOf(DomainError)
    await expect(harness.repo.findJob('job-corrupt')).rejects.toThrow(
      /job-corrupt has an unreadable snapshot/,
    )

    // An id that was simply never written is still absent rather than an error.
    expect(await harness.repo.findJob('job-never-written')).toBeUndefined()
  })

  // F4: a second process must wait for a lock rather than abort its whole run with
  // `database is locked`.
  it('opens the workspace database in WAL mode with a busy timeout', () => {
    const journal = harness.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
    expect(journal.journal_mode).toBe('wal')
    const busy = harness.db.prepare('PRAGMA busy_timeout').get() as { timeout: number }
    expect(busy.timeout).toBe(5000)
  })

  // F9: saveBook runs six-plus times per run; re-saving an unchanged book must not rewrite rows.
  it('writes no segment rows when an unchanged book is saved again', async () => {
    const book = makePlainBook(6)
    await harness.repo.saveBook(book)

    const countWrites = () =>
      (
        harness.db.prepare('SELECT total_changes() AS n').get() as {
          n: number
        }
      ).n

    const before = countWrites()
    await harness.repo.saveBook(book)
    await harness.repo.saveBook(book)
    const after = countWrites()

    // Two rows per call -- the books and chapters upserts -- and nothing else. Deleting and
    // re-inserting the segments instead would cost 12 more writes across these two calls, which
    // is the shape that made a 400-chapter book do millions of row writes per run.
    expect(after - before).toBeLessThanOrEqual(4)
    const segmentRows = harness.db.prepare('SELECT COUNT(*) AS n FROM segments').get() as {
      n: number
    }
    expect(segmentRows.n).toBe(6)
  })

  // ==========================================================================
  // Round 2 (second review, concurrency surface)
  // ==========================================================================

  // F1: the ledger is unique on (book_id, version) but the M4B name derives only from the
  // normalized title, so two different books sharing a title were handed the same m4bPath --
  // and the filesystem guard cannot help, because a reservation precedes file creation.
  it('never hands the same output path to two different books that share a title', async () => {
    const first = makeTitledBook('a'.repeat(64), 'Identical Title')
    const second = makeTitledBook('b'.repeat(64), 'Identical Title')
    expect(first.id).not.toBe(second.id)

    const r1 = await harness.repo.reserveNextOutput(first)
    const r2 = await harness.repo.reserveNextOutput(second)

    expect(r2.m4bPath).not.toBe(r1.m4bPath)
    // The second book takes v002 as its first output. Harmless, and it keeps the guarantee.
    expect(r1.version.value).toBe(1)
    expect(r2.version.value).toBe(2)

    // Every path in both reservations must be pairwise distinct, chapter masters included:
    // two assemblers running at once must not be able to write the same byte.
    const all = [
      r1.m4bPath,
      ...r1.chapters.map((chapter) => chapter.path),
      r2.m4bPath,
      ...r2.chapters.map((chapter) => chapter.path),
    ]
    expect(new Set(all).size).toBe(all.length)

    // A third book with the same title keeps climbing rather than colliding.
    const third = makeTitledBook('c'.repeat(64), 'Identical Title')
    const r3 = await harness.repo.reserveNextOutput(third)
    expect(r3.version.value).toBe(3)
    expect([r1.m4bPath, r2.m4bPath]).not.toContain(r3.m4bPath)
  })

  // F1, second axis: distinct titles that normalize to the same base name collide identically.
  it('separates output paths for books whose titles normalize to the same base name', async () => {
    const first = makeTitledBook('a'.repeat(64), 'Resume Story')
    const second = makeTitledBook('b'.repeat(64), 'resume   story!!')

    const r1 = await harness.repo.reserveNextOutput(first)
    const r2 = await harness.repo.reserveNextOutput(second)
    expect(r2.m4bPath).not.toBe(r1.m4bPath)
  })

  // F2: migrateSchema read the current version, ran DDL, and stamped the version without a
  // transaction, so two processes opening a fresh workspace both saw version 0 and the loser
  // died with `table books already exists`.
  it('survives many processes opening the same fresh workspace simultaneously', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'lna-open-race-'))
    createdRoots.push(fresh)
    const barrier = join(fresh, 'go')
    const child = join(dirname(fileURLToPath(import.meta.url)), 'open-workspace-child.ts')
    const run = promisify(execFile)

    const openers = Array.from({ length: 8 }, () =>
      run(process.execPath, ['--import', 'tsx', child, join(fresh, 'ws'), barrier], {
        maxBuffer: 1 << 22,
      })
        .then((result) => result.stdout.trim())
        .catch((error: Error & { stdout?: string }) => (error.stdout ?? '').trim()),
    )

    // Let every child boot tsx before releasing them onto the migration together.
    await new Promise((done) => setTimeout(done, 3000))
    writeFileSync(barrier, 'go')
    const outputs = await Promise.all(openers)

    const results = outputs.map((output) => {
      try {
        return JSON.parse(output.split('\n').at(-1) ?? '') as {
          ok: boolean
          message?: string
          schemaVersion?: number
        }
      } catch {
        return { ok: false, message: `unparseable output: ${output.slice(0, 200)}` }
      }
    })

    const failures = results.filter((result) => !result.ok).map((result) => result.message)
    expect(failures).toEqual([])
    expect(results.every((result) => result.schemaVersion === SCHEMA_VERSION)).toBe(true)
  }, 60_000)

  // F3: containment was purely lexical. layoutFor realpaths only the root, so a symlink at a
  // directory *below* the root passed the string prefix check and the assembler would have
  // written outside the workspace.
  it('refuses to reserve when a chapter directory is a symlink out of the workspace', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'lna-outside-'))
    createdRoots.push(outside)

    const { book } = makeBook()
    const chapterId = book.chapters[0]?.id
    if (chapterId === undefined) throw new Error('fixture chapter missing')

    mkdirSync(harness.layout.chapterDir, { recursive: true })
    symlinkSync(outside, join(harness.layout.chapterDir, `ch-${chapterId}`), 'dir')

    await expect(harness.repo.reserveNextOutput(book)).rejects.toBeInstanceOf(DomainError)
    const rows = harness.db
      .prepare('SELECT COUNT(*) AS n FROM output_reservations WHERE book_id = ?')
      .get(book.id) as { n: number }
    expect(rows.n).toBe(0)
  })

  it('refuses to reserve when the output directory is a symlink out of the workspace', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'lna-outside-out-'))
    createdRoots.push(outside)

    const { book } = makeBook()
    rmSync(harness.layout.outputDir, { recursive: true, force: true })
    symlinkSync(outside, harness.layout.outputDir, 'dir')

    await expect(harness.repo.reserveNextOutput(book)).rejects.toBeInstanceOf(DomainError)
  })

  it('resolves reserved paths to real directories inside the workspace', async () => {
    const { book } = makeBook()
    const reservation = await harness.repo.reserveNextOutput(book)
    const realRoot = realpathSync(harness.layout.root)

    // The canonical parent of every reserved path must sit under the canonical root, so a
    // symlink anywhere below the root cannot redirect a write.
    for (const path of [reservation.m4bPath, ...reservation.chapters.map((c) => c.path)]) {
      const realParent = realpathSync(dirname(path))
      expect(realParent === realRoot || realParent.startsWith(`${realRoot}${sep}`)).toBe(true)
    }
  })

  // F5: a NUL passed the lexical assertion, SQLite accepted the row, and mkdirSync then threw
  // *after* commit -- consuming a version on every retry and wedging the book permanently.
  it('rejects a chapter id with a NUL or separator before claiming a version', async () => {
    const badIds = [
      'chapter\u0000null',
      'chapter/slash',
      'chapter\\backslash',
      'chapter\u0007bell',
      'chapter\nnewline',
    ]
    for (const badId of badIds) {
      const chapter = new Chapter({
        id: badId,
        bookId: BOOK_ID,
        position: 1,
        title: 'Bad',
        sourcePassages: [
          new SourcePassage({ id: `${badId}-p1`, chapterId: badId, sourceText: 'Text.' }),
        ],
      })
      const book = new Book({
        id: BOOK_ID,
        title: 'Bad Chapter Book',
        author: null,
        coverPath: null,
        source: { epubPath: '/uploads/bad.epub', sha256: SOURCE_HASH },
        chapters: [chapter],
      })

      await expect(harness.repo.reserveNextOutput(book)).rejects.toBeInstanceOf(DomainError)
      // Nothing may be committed, or the next attempt burns another version and fails the same way.
      const rows = harness.db
        .prepare('SELECT COUNT(*) AS n FROM output_reservations WHERE book_id = ?')
        .get(BOOK_ID) as { n: number }
      expect(rows.n).toBe(0)
    }
  })

  // F6: fileExists required stat().isFile(), so a *directory* sitting at the exact reserved
  // path read as free. Assembly then cannot create the output and the version is consumed.
  it('treats any entry at the exact output path as occupied, not just a file', async () => {
    const { book } = makeBook()

    // outputBaseName('Resume Story') === 'resume-story'
    mkdirSync(join(harness.layout.outputDir, 'resume-story-v001.m4b'), { recursive: true })

    const reservation = await harness.repo.reserveNextOutput(book)
    expect(reservation.version.value).toBe(2)
    expect(reservation.m4bPath.endsWith('resume-story-v002.m4b')).toBe(true)
  })

  it('treats a dangling symlink at the exact output path as occupied', async () => {
    const { book } = makeBook()
    symlinkSync(
      join(harness.layout.outputDir, 'nowhere-at-all'),
      join(harness.layout.outputDir, 'resume-story-v001.m4b'),
    )

    const reservation = await harness.repo.reserveNextOutput(book)
    expect(reservation.version.value).toBe(2)
  })

  it('treats a non-dot directory at an exact chapter master path as occupied', async () => {
    const { book } = makeBook()
    const chapterId = book.chapters[0]?.id
    if (chapterId === undefined) throw new Error('fixture chapter missing')
    const chapterDir = join(harness.layout.chapterDir, `ch-${chapterId}`)
    mkdirSync(join(chapterDir, 'resume-story-ch001-v001.flac'), { recursive: true })

    const reservation = await harness.repo.reserveNextOutput(book)
    expect(reservation.version.value).toBe(2)
  })
})
