/**
 * Prerequisite 2 for issue #45: a render stage that did not direct the book must be able to read the
 * approved script back. Under schema 1 the `segments` table held `source_text_sha256` and no voice
 * assignment, from which no `Segment` can be rebuilt and no render input identity reproduced.
 *
 * The load-bearing assertion is the identity comparison: every round-tripped segment must produce
 * the *same* `createRenderInputIdentity` as the segment direction created. A round trip that lost
 * source text, delivery, speaker, order or the voice assignment would still return a plausible book
 * — and would silently re-render the whole audiobook, or worse, render different audio under an
 * address that already had a WAV. Comparing the identities is the only assertion that catches all of
 * those at once.
 *
 * All story text below is invented for this fixture.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  createBookFallbackGrant,
  createFallbackApprovalRecord,
  createRenderInputIdentity,
  hashSourceText,
} from '@light-novel-audiobook/application'
import {
  Book,
  Chapter,
  DomainError,
  ExactSourceCoverage,
  type Segment,
  SourcePassage,
  StableIds,
  VoiceCast,
  VoiceProfile,
} from '@light-novel-audiobook/domain'
import { afterEach, describe, expect, it } from 'vitest'
import {
  layoutFor,
  openWorkspace,
  SqliteFallbackApprovalRepository,
  SqliteJobRepository,
} from '../src/index.js'

const SOURCE_HASH = 'c3'.repeat(32)
const BOOK_ID = StableIds.book(SOURCE_HASH)
const ENGINE = 'qwen:model-revision-1:settings-1'
const DECIDED_AT = '2026-07-25T10:00:00.000Z'

const voice = (
  id: string,
  role: 'narrator' | 'character' | 'fallback',
  speakerId: string | null,
): VoiceProfile =>
  new VoiceProfile({
    id,
    displayName: id,
    role,
    speakerId,
    syntheticSpeaker: role === 'narrator' ? 'Aiden' : 'Ryan',
    instruction: `${id} restrained delivery`,
    seed: 9205,
    revision: 1,
  })

const cast = new VoiceCast(
  voice('cast-narrator', 'narrator', null),
  voice('cast-fallback', 'fallback', null),
  [voice('cast-alice', 'character', 'alice')],
)

const LINES = [
  {
    text: 'The corridor lights flickered twice. ',
    kind: 'narration' as const,
    speakerId: null,
    emotion: 'calm',
  },
  { text: '“You are early,” ', kind: 'dialogue' as const, speakerId: 'alice', emotion: 'warm' },
  {
    text: '“The gate does not lock itself.” ',
    kind: 'dialogue' as const,
    speakerId: null,
    emotion: 'flat',
  },
  {
    text: '“Then bring the keeper.”',
    kind: 'dialogue' as const,
    speakerId: 'mira',
    emotion: 'wary',
  },
]

/** A directed, voice-assigned, approved single-chapter book — exactly what `DirectAudiobook` saves. */
const directedBook = (): Book => {
  const chapterId = StableIds.chapter(BOOK_ID, 1)
  const passageId = StableIds.passage(chapterId, 1)
  const chapter = new Chapter({
    id: chapterId,
    bookId: BOOK_ID,
    position: 1,
    title: 'A Locked Gate',
    sourcePassages: [
      new SourcePassage({
        id: passageId,
        chapterId,
        sourceText: LINES.map((line) => line.text).join(''),
      }),
    ],
  })
  const segments = ExactSourceCoverage.createSegments(
    chapter,
    LINES.map((line) => ({
      sourcePassageId: passageId,
      sourceText: line.text,
      kind: line.kind,
      speakerId: line.speakerId,
      confidence: line.speakerId === null && line.kind === 'dialogue' ? 0.4 : 0.96,
      delivery: {
        emotion: line.emotion,
        pace: 'slow' as const,
        volume: 'soft' as const,
        pauseAfterMs: 340,
      },
    })),
  )
  for (const segment of segments) segment.assignVoice(cast.resolve(segment).assignment)
  chapter.submitForReview(segments)
  chapter.approve()
  return new Book({
    id: BOOK_ID,
    title: 'Round Trip Fixture',
    author: 'Fixture Author',
    coverPath: '/workspace/cover.jpg',
    source: { epubPath: '/uploads/round-trip.epub', sha256: SOURCE_HASH },
    chapters: [chapter],
  })
}

const identitiesOf = (book: Book): Map<string, string> => {
  const identities = new Map<string, string>()
  for (const chapter of book.chapters) {
    for (const segment of chapter.segments) {
      const assignment = segment.voiceAssignment
      if (assignment === null) throw new Error(`fixture segment ${segment.id} has no voice`)
      identities.set(
        segment.id,
        createRenderInputIdentity(segment, cast.profile(assignment.voiceProfileId), ENGINE),
      )
    }
  }
  return identities
}

const roots: string[] = []
const databases: DatabaseSync[] = []

const workspace = async (): Promise<{
  jobs: SqliteJobRepository
  approvals: SqliteFallbackApprovalRepository
}> => {
  const root = await mkdtemp(join(tmpdir(), 'lna-round-trip-'))
  roots.push(root)
  const layout = layoutFor(root)
  const db = openWorkspace(layout)
  databases.push(db)
  return {
    jobs: new SqliteJobRepository(layout, db),
    approvals: new SqliteFallbackApprovalRepository(db),
  }
}

afterEach(async () => {
  for (const db of databases.splice(0)) {
    try {
      db.close()
    } catch {
      // Already closed; the temporary root is removed either way.
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('approved script read path (issue #45, prerequisite 2)', () => {
  it('reproduces every segment render input identity after a save and read', async () => {
    const { jobs } = await workspace()
    const original = directedBook()
    await jobs.saveBook(original)

    const reloaded = await jobs.findBook(BOOK_ID)
    if (reloaded === undefined) throw new Error('approved script did not come back')

    // THE assertion this test exists for. Every speech-affecting input is inside these hashes, so a
    // round trip that dropped any of them cannot match.
    expect(Object.fromEntries(identitiesOf(reloaded))).toEqual(
      Object.fromEntries(identitiesOf(original)),
    )

    // Spelled out as well, so a failure says which field was lost rather than only "hashes differ".
    const before = original.chapters[0]?.segments ?? []
    const after = reloaded.chapters[0]?.segments ?? []
    expect(after).toHaveLength(before.length)
    expect(after.map((segment: Segment) => segment.sourceText)).toEqual(
      LINES.map((line) => line.text),
    )
    expect(after.map((segment: Segment) => segment.voiceAssignment)).toEqual(
      before.map((segment: Segment) => segment.voiceAssignment),
    )
    expect(after.map((segment: Segment) => segment.delivery)).toEqual(
      before.map((segment: Segment) => segment.delivery),
    )
    expect(after.map((segment: Segment) => segment.speakerId)).toEqual(
      LINES.map((line) => line.speakerId),
    )
    expect(after.map((segment: Segment) => segment.confidence)).toEqual(
      before.map((segment: Segment) => segment.confidence),
    )
    expect(after.map((segment: Segment) => segment.order)).toEqual([1, 2, 3, 4])

    // Book-level material the render stage also needs.
    expect(reloaded.title).toBe(original.title)
    expect(reloaded.author).toBe(original.author)
    expect(reloaded.coverPath).toBe(original.coverPath)
    expect(reloaded.source).toEqual(original.source)
    expect(reloaded.chapters[0]?.sourcePassages.map((passage) => passage.sourceText)).toEqual(
      original.chapters[0]?.sourcePassages.map((passage) => passage.sourceText),
    )
  })

  it('comes back approved and ready to render, without the previous run render state', async () => {
    const { jobs } = await workspace()
    const original = directedBook()
    const chapter = original.chapters[0]
    if (chapter === undefined) throw new Error('fixture chapter missing')
    chapter.beginRendering()
    chapter.markRendered()
    await jobs.saveBook(original)

    const reloaded = await jobs.findBook(BOOK_ID)
    // `rendered` can only transition to `draft`, so restoring render state would make a re-render
    // after a review decision impossible.
    expect(reloaded?.chapters.map((item) => item.state)).toEqual(['approved'])
    expect(() => reloaded?.chapters[0]?.beginRendering()).not.toThrow()
  })

  it('returns undefined for a book that was never saved', async () => {
    const { jobs } = await workspace()
    expect(await jobs.findBook(StableIds.book('f'.repeat(64)))).toBeUndefined()
    await expect(jobs.findBook('')).rejects.toThrow(DomainError)
  })

  it('reads back a book whose chapters were never directed, without claiming they are approved', async () => {
    const { jobs } = await workspace()
    const chapterId = StableIds.chapter(BOOK_ID, 1)
    const undirected = new Book({
      id: BOOK_ID,
      title: 'Undirected',
      author: null,
      coverPath: null,
      source: { epubPath: '/uploads/undirected.epub', sha256: SOURCE_HASH },
      chapters: [
        new Chapter({
          id: chapterId,
          bookId: BOOK_ID,
          position: 1,
          title: 'Draft',
          sourcePassages: [
            new SourcePassage({
              id: StableIds.passage(chapterId, 1),
              chapterId,
              sourceText: 'Only extracted so far.',
            }),
          ],
        }),
      ],
    })
    await jobs.saveBook(undirected)

    const reloaded = await jobs.findBook(BOOK_ID)
    expect(reloaded?.chapters.map((chapter) => chapter.state)).toEqual(['draft'])
    expect(reloaded?.chapters[0]?.segments).toEqual([])
  })
})

describe('fallback approval ledger (issue #45)', () => {
  const decision = (segmentId: string, decidedAt = DECIDED_AT, grantId: string | null = null) =>
    createFallbackApprovalRecord({
      bookId: BOOK_ID,
      segmentId,
      speakerId: 'mira',
      fallbackReason: 'missing_speaker_voice',
      voiceProfileId: 'cast-fallback',
      sourceTextSha256: hashSourceText('“Then bring the keeper.”'),
      decidedAt,
      decidedBy: 'local-reviewer',
      grantId,
    })

  const ACTOR = { decidedBy: 'local-reviewer', decidedAt: DECIDED_AT }
  const liveApprovals = async (approvals: SqliteFallbackApprovalRepository, bookId = BOOK_ID) =>
    (await approvals.readCatalog(bookId)).approvals

  it('stores, lists, supersedes and revokes one decision per segment', async () => {
    const { approvals } = await workspace()
    const chapterId = StableIds.chapter(BOOK_ID, 1)
    const first = StableIds.segment(StableIds.passage(chapterId, 1), 4)
    const second = StableIds.segment(StableIds.passage(chapterId, 2), 1)

    await approvals.save(decision(first))
    await approvals.save(decision(second))
    expect((await liveApprovals(approvals)).map((record) => record.segmentId)).toEqual([
      first,
      second,
    ])
    expect(await liveApprovals(approvals, StableIds.book('e'.repeat(64)))).toEqual([])

    // A newer decision about the same segment supersedes the older one rather than adding a row a
    // later query could read as a second live approval.
    const revised = decision(first, '2026-07-25T12:00:00.000Z')
    await approvals.save(revised)
    const live = await liveApprovals(approvals)
    expect(live).toHaveLength(2)
    expect(live.find((record) => record.segmentId === first)?.approvalId).toBe(revised.approvalId)

    expect(await approvals.revoke(BOOK_ID, first, 'human-withdrawal', ACTOR)).toBe(true)
    expect(await approvals.revoke(BOOK_ID, first, 'human-withdrawal', ACTOR)).toBe(false)
    expect((await liveApprovals(approvals)).map((record) => record.segmentId)).toEqual([second])
    // A human withdrawal is recorded, so a later book-wide grant cannot silently re-create it.
    expect((await approvals.readCatalog(BOOK_ID)).exclusions.map((item) => item.segmentId)).toEqual(
      [first],
    )
  })

  it('bumps the catalog revision on every mutation and never on a read', async () => {
    // This counter is what lets a render claim a catalog and prove nothing moved under it, so a
    // mutation that failed to bump it would silently reopen the race it exists to close.
    const { approvals } = await workspace()
    const segmentId = StableIds.segment(StableIds.passage(StableIds.chapter(BOOK_ID, 1), 1), 4)
    expect((await approvals.readCatalog(BOOK_ID)).revision).toBe(0)

    await approvals.save(decision(segmentId))
    const afterSave = (await approvals.readCatalog(BOOK_ID)).revision
    expect(afterSave).toBe(1)
    // Reads never move it.
    expect((await approvals.readCatalog(BOOK_ID)).revision).toBe(afterSave)

    await approvals.revoke(BOOK_ID, segmentId, 'human-withdrawal', ACTOR)
    expect((await approvals.readCatalog(BOOK_ID)).revision).toBe(2)
    // Even a revocation that removed nothing is a mutation: it recorded the exclusion.
    await approvals.revoke(BOOK_ID, segmentId, 'human-withdrawal', ACTOR)
    expect((await approvals.readCatalog(BOOK_ID)).revision).toBe(3)

    await approvals.saveBookGrant(
      createBookFallbackGrant({
        bookId: BOOK_ID,
        decidedBy: 'local-reviewer',
        decidedAt: DECIDED_AT,
      }),
    )
    expect((await approvals.readCatalog(BOOK_ID)).revision).toBe(4)
    expect((await approvals.readCatalog(BOOK_ID)).grant?.decidedBy).toBe('local-reviewer')

    expect(await approvals.revokeBookGrant(BOOK_ID)).toBe(true)
    const final = await approvals.readCatalog(BOOK_ID)
    expect(final.revision).toBe(5)
    expect(final.grant).toBeUndefined()
  })

  it('keeps an approval and its exclusion mutually exclusive', async () => {
    const { approvals } = await workspace()
    const segmentId = StableIds.segment(StableIds.passage(StableIds.chapter(BOOK_ID, 1), 1), 4)
    await approvals.save(decision(segmentId))
    await approvals.revoke(BOOK_ID, segmentId, 'human-withdrawal', ACTOR)

    let catalog = await approvals.readCatalog(BOOK_ID)
    expect(catalog.approvals).toEqual([])
    expect(catalog.exclusions).toHaveLength(1)

    // Approving again clears the withdrawal, or a book-wide grant would stay blocked forever.
    await approvals.save(decision(segmentId, '2026-07-26T09:00:00.000Z'))
    catalog = await approvals.readCatalog(BOOK_ID)
    expect(catalog.approvals).toHaveLength(1)
    expect(catalog.exclusions).toEqual([])
  })

  it('does not record an exclusion for a system invalidation', async () => {
    // A decision that no longer describes its segment must be re-derivable. Recording it as an
    // exclusion would block that segment permanently instead of letting it be decided again.
    const { approvals } = await workspace()
    const segmentId = StableIds.segment(StableIds.passage(StableIds.chapter(BOOK_ID, 1), 1), 4)
    await approvals.save(decision(segmentId))
    expect(await approvals.revoke(BOOK_ID, segmentId, 'no-longer-describes-segment', ACTOR)).toBe(
      true,
    )
    const catalog = await approvals.readCatalog(BOOK_ID)
    expect(catalog.approvals).toEqual([])
    expect(catalog.exclusions).toEqual([])
  })

  it('refuses a record whose identity does not follow from its own decision', async () => {
    const { approvals } = await workspace()
    const chapterId = StableIds.chapter(BOOK_ID, 1)
    const segmentId = StableIds.segment(StableIds.passage(chapterId, 1), 4)
    const forged = { ...decision(segmentId), approvalSha256: 'a'.repeat(64) }
    await expect(approvals.save(forged)).rejects.toThrow('does not match its own decision identity')
    expect(await liveApprovals(approvals)).toEqual([])
  })

  it('survives a saveBook that replaces the chapter its decisions point at', async () => {
    // A cascade from segments would delete human decisions as a side effect of re-saving the book.
    const { jobs, approvals } = await workspace()
    const book = directedBook()
    await jobs.saveBook(book)
    const segmentId = book.chapters[0]?.segments[3]?.id
    if (segmentId === undefined) throw new Error('fixture segment missing')
    await approvals.save(decision(segmentId))

    await jobs.saveBook(directedBook())
    expect((await liveApprovals(approvals)).map((record) => record.segmentId)).toEqual([segmentId])
  })
})
