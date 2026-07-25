import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  type CompletedSegmentAudio,
  createRenderInputIdentity,
} from '@light-novel-audiobook/application'
import {
  AudiobookJob,
  Book,
  Chapter,
  type DirectedSegment,
  ExactSourceCoverage,
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
    job.beginDirection()
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
    await harness.repo.saveCompletedSegment(artifact1)
    job.recordSegmentCompleted(seg1.id)

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
    const r2 = await harness.repo.reserveNextOutput(book)
    const r3 = await harness.repo.reserveNextOutput(book)
    expect([r1.version.value, r2.version.value, r3.version.value]).toEqual([1, 2, 3])
    const paths = [r1.m4bPath, r2.m4bPath, r3.m4bPath]
    expect(new Set(paths).size).toBe(3)

    // Restart: the persisted reservation counter must keep climbing.
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
})
