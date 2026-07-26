import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  Book,
  Chapter,
  ExactSourceCoverage,
  SourceCoverageError,
  SourcePassage,
  StableIds,
} from '@light-novel-audiobook/domain'
import { afterEach, describe, expect, it } from 'vitest'
import { layoutFor, openWorkspace, SqliteJobRepository } from '../src/index.js'

const SOURCE_HASH = '8'.repeat(64)
const BOOK_ID = StableIds.book(SOURCE_HASH)
const chapterId = (position: number): string => StableIds.chapter(BOOK_ID, position)
const passageId = (chapterPosition: number, passagePosition: number): string =>
  StableIds.passage(chapterId(chapterPosition), passagePosition)

const directedBook = (): Book => {
  const chapters = Array.from({ length: 3 }, (_, chapterIndex) => {
    const chapterPosition = chapterIndex + 1
    const id = chapterId(chapterPosition)
    const sourcePassages = Array.from({ length: 4 }, (_, passageIndex) => {
      const passagePosition = passageIndex + 1
      return new SourcePassage({
        id: passageId(chapterPosition, passagePosition),
        chapterId: id,
        sourceText: `Synthetic chapter ${chapterPosition} passage ${passagePosition}.`,
      })
    })
    const chapter = new Chapter({
      id,
      bookId: BOOK_ID,
      position: chapterPosition,
      title: `Synthetic chapter ${chapterPosition}`,
      sourcePassages,
    })
    const segments = ExactSourceCoverage.createSegments(
      chapter,
      sourcePassages.map((passage) => ({
        sourcePassageId: passage.id,
        sourceText: passage.sourceText,
        kind: 'narration' as const,
        speakerId: null,
        confidence: 1,
        delivery: {
          emotion: 'neutral',
          pace: 'normal' as const,
          volume: 'normal' as const,
          pauseAfterMs: 0,
        },
      })),
    )
    for (const segment of segments) {
      segment.assignVoice({
        voiceProfileId: 'synthetic-narrator',
        usesFallback: false,
        fallbackReason: null,
      })
    }
    chapter.submitForReview(segments)
    chapter.approve()
    return chapter
  })

  return new Book({
    id: BOOK_ID,
    title: 'Synthetic coverage fixture',
    author: null,
    coverPath: null,
    source: { epubPath: '/synthetic/coverage.epub', sha256: SOURCE_HASH },
    chapters,
  })
}

const roots: string[] = []
const databases: DatabaseSync[] = []

const workspace = async (): Promise<{ db: DatabaseSync; jobs: SqliteJobRepository }> => {
  const root = await mkdtemp(join(tmpdir(), 'lna-persisted-coverage-'))
  roots.push(root)
  const layout = layoutFor(root)
  const db = openWorkspace(layout)
  databases.push(db)
  return { db, jobs: new SqliteJobRepository(layout, db) }
}

afterEach(async () => {
  for (const db of databases.splice(0)) db.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const resequenceAfterDrop = (db: DatabaseSync, ownerChapterId: string, position: number): void => {
  db.prepare('DELETE FROM segments WHERE chapter_id = ? AND position = ?').run(
    ownerChapterId,
    position,
  )
  const rows = db
    .prepare('SELECT id FROM segments WHERE chapter_id = ? ORDER BY position')
    .all(ownerChapterId) as unknown as { id: string }[]
  db.prepare('UPDATE segments SET position = position + 100 WHERE chapter_id = ?').run(
    ownerChapterId,
  )
  const setPosition = db.prepare('UPDATE segments SET position = ? WHERE id = ?')
  for (const [index, row] of rows.entries()) setPosition.run(index + 1, row.id)
}

const duplicatePassage = (db: DatabaseSync, ownerChapterId: string): void => {
  const source = db
    .prepare(
      `SELECT id, source_passage_id, source_text, kind, speaker_id, confidence, delivery,
              voice_profile_id, uses_fallback, fallback_reason
         FROM segments WHERE chapter_id = ? AND position = 2`,
    )
    .get(ownerChapterId) as
    | {
        id: string
        source_passage_id: string
        source_text: string
        kind: string
        speaker_id: string | null
        confidence: number
        delivery: string
        voice_profile_id: string
        uses_fallback: number
        fallback_reason: string | null
      }
    | undefined
  if (source === undefined) throw new Error('synthetic segment missing')
  db.prepare(
    `INSERT INTO segments
      (id, chapter_id, position, source_passage_id, source_text, kind, speaker_id, confidence,
       delivery, voice_profile_id, uses_fallback, fallback_reason)
     VALUES (?, ?, 5, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `${source.id}-duplicate`,
    ownerChapterId,
    source.source_passage_id,
    source.source_text,
    source.kind,
    source.speaker_id,
    source.confidence,
    source.delivery,
    source.voice_profile_id,
    source.uses_fallback,
    source.fallback_reason,
  )
}

const reorderAdjacent = (db: DatabaseSync, ownerChapterId: string): void => {
  const setPosition = db.prepare(
    'UPDATE segments SET position = ? WHERE chapter_id = ? AND position = ?',
  )
  setPosition.run(100, ownerChapterId, 2)
  setPosition.run(2, ownerChapterId, 3)
  setPosition.run(3, ownerChapterId, 100)
}

interface CoverageMutation {
  readonly name: string
  readonly mutate: (db: DatabaseSync) => void
}

const COVERAGE_MUTATIONS: readonly CoverageMutation[] = [
  {
    name: 'drop first',
    mutate: (db) => resequenceAfterDrop(db, chapterId(2), 1),
  },
  {
    name: 'drop middle',
    mutate: (db) => resequenceAfterDrop(db, chapterId(2), 2),
  },
  {
    name: 'drop last',
    mutate: (db) => resequenceAfterDrop(db, chapterId(2), 4),
  },
  {
    name: 'duplicate under a fresh ID',
    mutate: (db) => duplicatePassage(db, chapterId(2)),
  },
  {
    name: 'reorder adjacent',
    mutate: (db) => reorderAdjacent(db, chapterId(2)),
  },
  {
    name: 'drop immediately before a chapter boundary',
    mutate: (db) => resequenceAfterDrop(db, chapterId(1), 4),
  },
  {
    name: 'drop immediately after a chapter boundary',
    mutate: (db) => resequenceAfterDrop(db, chapterId(3), 1),
  },
]

describe('persisted approved script exact source coverage (issue #88)', () => {
  it.each(COVERAGE_MUTATIONS)('rejects $name', async ({ mutate }) => {
    const { db, jobs } = await workspace()
    await jobs.saveBook(directedBook())
    mutate(db)

    await expect(jobs.findBook(BOOK_ID)).rejects.toThrow(SourceCoverageError)
  })

  it('rejects a segment whose source text no longer byte-matches its passage', async () => {
    const { db, jobs } = await workspace()
    await jobs.saveBook(directedBook())
    db.prepare('UPDATE segments SET source_text = ? WHERE id = ?').run(
      'Synthetic chapter 2 passage 2!',
      StableIds.segment(passageId(2, 2), 1),
    )

    await expect(jobs.findBook(BOOK_ID)).rejects.toThrow(SourceCoverageError)
  })
})
