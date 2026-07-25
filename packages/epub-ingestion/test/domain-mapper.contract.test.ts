import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EpubExtractor } from '@light-novel-audiobook/application'
import { Book } from '@light-novel-audiobook/domain'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DOMAIN_EPUB_EXTRACTOR_IDENTITY,
  DOMAIN_EPUB_EXTRACTOR_SETTINGS,
  DomainEpubExtractor,
  type StoredEpubIngestion,
} from '../src/index.js'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const fixturePath = path.join(repositoryRoot, 'tests/fixtures/epub/synthetic-complex.epub')
const temporaryDirectories: string[] = []

async function workspace(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'epub-domain-contract-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('issue #29 EpubExtractor contract', () => {
  it('maps uploaded bytes to a valid Book without empty chapters or zero-based positions', async () => {
    const workspaceRoot = await workspace()
    const extractor: EpubExtractor = new DomainEpubExtractor({
      workspaceRoot,
      repositoryRoot,
    })

    const expectedIdentity = `domain-epub-extractor@1:${createHash('sha256')
      .update(JSON.stringify(DOMAIN_EPUB_EXTRACTOR_SETTINGS))
      .digest('hex')}`
    expect(extractor.identity).toBe(DOMAIN_EPUB_EXTRACTOR_IDENTITY)
    expect(extractor.identity).toBe(expectedIdentity)
    expect(extractor.identity).toMatch(/^domain-epub-extractor@1:[a-f0-9]{64}$/)

    const book = await extractor.extract({ epubPath: fixturePath })

    expect(book).toBeInstanceOf(Book)
    expect(book.title).toBe('Clockwork Lantern — Synthetic Fixture')
    expect(book.author).toBe('Fixture Author')
    expect(book.chapters.map((chapter) => chapter.position)).toEqual([1, 2, 3, 4, 5])
    expect(book.chapters.every((chapter) => chapter.title.length > 0)).toBe(true)
    expect(book.chapters.every((chapter) => chapter.sourcePassages.length > 0)).toBe(true)
    expect(
      book.chapters.flatMap((chapter) =>
        chapter.sourcePassages.map((passage) => passage.sourceText),
      ),
    ).toEqual([
      'CLOCKWORK LANTERN',
      '1',
      'The Brass Door',
      'A & B 🙂 é \u00a0 end.',
      '  Keep\tboth\nspaces.  ',
      'She opened the door—slowly.',
      'The mark 星 glowed.*',
      'Figure 1',
      'The Brass Door',
      '“Nothing moved,” said Noa.',
      'Was this a memory, or a warning?',
      '* The inventor’s original wording.',
      '*',
      'After the Bell',
      'Noa carried the lantern home.',
    ])
    expect(path.isAbsolute(book.source.epubPath)).toBe(true)
    // The fixture declares an SVG cover, which ingestion rejects before this domain boundary
    // because the pinned M4B toolchain cannot rasterize it.
    expect(book.coverPath).toBeNull()

    const manifest = JSON.parse(
      await readFile(path.join(workspaceRoot, 'books', book.id, 'book.json'), 'utf8'),
    ) as StoredEpubIngestion
    expect(manifest.cover).toBeNull()
    expect(manifest.audit.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'unusable-cover',
          locators: ['EPUB/images/lantern.svg'],
        }),
      ]),
    )
    expect(manifest.audit.nonStoryDocuments).toEqual([
      expect.objectContaining({
        sourceArchivePath: 'EPUB/image-page.xhtml',
        classification: 'no-source-passages',
        spinePosition: 4,
      }),
    ])
    expect(book.chapters.some((chapter) => chapter.title === 'Illustration')).toBe(false)
  })
})
