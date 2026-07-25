import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { EpubExtractionRequest, EpubExtractor } from '@light-novel-audiobook/application'
import { Book, Chapter, SourcePassage, StableIds } from '@light-novel-audiobook/domain'
import { WebApiError } from '../errors.js'
import { FIXTURE_CHAPTERS } from './fixture-book.js'

const humanizeTitle = (epubPath: string): string => {
  const stem = basename(epubPath)
    .replace(/\.epub$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim()
  if (stem.length === 0) return 'Untitled Book'
  return stem.replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
}

/**
 * FAKE extractor. It hashes the real uploaded bytes so book and job identity stay honest, then
 * returns a small built-in fixture instead of parsing the container. Issue #28 replaces it.
 */
export class FakeEpubExtractor implements EpubExtractor {
  readonly identity = 'fake-epub-extractor/1'

  async extract(request: EpubExtractionRequest): Promise<Book> {
    let bytes: Buffer
    try {
      bytes = await readFile(request.epubPath)
    } catch {
      throw new WebApiError('unknown_upload', 'The uploaded EPUB is no longer readable.')
    }

    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const bookId = StableIds.book(sha256)
    const chapters = FIXTURE_CHAPTERS.map((fixture, index) => {
      const position = index + 1
      const chapterId = StableIds.chapter(bookId, position)
      return new Chapter({
        id: chapterId,
        bookId,
        position,
        title: fixture.title,
        sourcePassages: fixture.passages.map(
          (sourceText, passageIndex) =>
            new SourcePassage({
              id: StableIds.passage(chapterId, passageIndex + 1),
              chapterId,
              sourceText,
            }),
        ),
      })
    })

    return new Book({
      id: bookId,
      title: humanizeTitle(request.epubPath),
      author: 'Fixture Author',
      coverPath: null,
      source: { epubPath: request.epubPath, sha256 },
      chapters,
    })
  }
}
