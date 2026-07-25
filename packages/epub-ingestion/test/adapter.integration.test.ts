import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_EPUB_ARCHIVE_LIMITS,
  deriveBookId,
  EpubIngestionAdapter,
  type EpubIngestionError,
  extractEpubDeterministically,
  type StorageCommitPoint,
  type StoredEpubIngestion,
  unzipEpubSafely,
} from '../src/index.js'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const fixtureRoot = path.join(repositoryRoot, 'tests/fixtures/epub')
const temporaryDirectories: string[] = []

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), `epub-ingestion-${label}-`))
  temporaryDirectories.push(directory)
  return directory
}

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path.join(fixtureRoot, `${name}.epub`)))
}

function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

interface ZipEntryOffsets {
  readonly central: number
  readonly local: number
  readonly nameLength: number
}

function zipEntryOffsets(archive: Uint8Array, expectedName: string): ZipEntryOffsets {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
  let end = -1
  for (let offset = archive.byteLength - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      end = offset
      break
    }
  }
  if (end < 0) throw new Error('test archive has no central directory')
  const count = view.getUint16(end + 10, true)
  let central = view.getUint32(end + 16, true)
  for (let index = 0; index < count; index += 1) {
    const nameLength = view.getUint16(central + 28, true)
    const extraLength = view.getUint16(central + 30, true)
    const commentLength = view.getUint16(central + 32, true)
    const name = new TextDecoder().decode(archive.subarray(central + 46, central + 46 + nameLength))
    if (name === expectedName) {
      return {
        central,
        local: view.getUint32(central + 42, true),
        nameLength,
      }
    }
    central += 46 + nameLength + extraLength + commentLength
  }
  throw new Error(`test archive has no entry ${expectedName}`)
}

function replaceZipEntryName(
  archive: Uint8Array,
  currentName: string,
  replacementName: string,
): Uint8Array {
  const changed = Uint8Array.from(archive)
  const offsets = zipEntryOffsets(changed, currentName)
  const replacement = new TextEncoder().encode(replacementName)
  if (replacement.byteLength !== offsets.nameLength) {
    throw new Error('test replacement ZIP name must have the same byte length')
  }
  changed.set(replacement, offsets.central + 46)
  changed.set(replacement, offsets.local + 30)
  return changed
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('production EPUB ingestion adapter', () => {
  it('atomically stores an upload and maps exact passages in spine order', async () => {
    const workspace = await temporaryDirectory('ordered')
    const bytes = await fixture('synthetic-complex')
    const adapter = new EpubIngestionAdapter({ workspaceRoot: workspace, repositoryRoot })

    const ingested = await adapter.ingest({
      bytes,
      originalFilename: 'clockwork-lantern.epub',
    })

    expect(ingested.chapters.map((chapter) => chapter.sourceArchivePath)).toEqual([
      'EPUB/chapter-1.xhtml',
      'EPUB/chapter-2.xhtml',
      'EPUB/notes.xhtml',
      'EPUB/low-text.xhtml',
      'EPUB/side-story.xhtml',
    ])
    expect(ingested.chapters.map((chapter) => chapter.position)).toEqual([1, 2, 3, 4, 5])
    expect(ingested.chapters.map((chapter) => chapter.spinePosition)).toEqual([1, 2, 3, 5, 6])
    expect(
      ingested.chapters.map((chapter) => chapter.passages.map((passage) => passage.position)),
    ).toEqual([[1, 2, 3, 4, 5, 6, 7, 8], [1, 2, 3], [1], [1], [1, 2]])
    expect(
      ingested.chapters.flatMap((chapter) => chapter.passages.map((passage) => passage.sourceText)),
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
    expect(Object.isFrozen(ingested)).toBe(true)
    expect(Object.isFrozen(ingested.chapters[0]?.passages[0])).toBe(true)
    expect(new Set(ingested.chapters.map((chapter) => chapter.id)).size).toBe(
      ingested.chapters.length,
    )
    expect(
      new Set(ingested.chapters.flatMap((chapter) => chapter.passages.map((passage) => passage.id)))
        .size,
    ).toBe(15)

    const storedUpload = await readFile(path.join(workspace, ingested.upload.relativePath))
    expect(new Uint8Array(storedUpload)).toEqual(bytes)
    expect(ingested.upload.sha256).toBe(hash(bytes))
    const manifestPath = path.join(workspace, 'books', ingested.id, 'book.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as StoredEpubIngestion
    expect(manifest).toEqual(ingested)
    expect(await readdir(path.join(workspace, '.staging'))).toEqual([])

    const repeated = await adapter.ingest({ bytes, originalFilename: 'renamed-upload.epub' })
    expect(repeated).toEqual(ingested)

    const secondWorkspace = await temporaryDirectory('stable-identities')
    const independentlyIngested = await new EpubIngestionAdapter({
      workspaceRoot: secondWorkspace,
      repositoryRoot,
    }).ingest({ bytes })
    expect(independentlyIngested.id).toBe(ingested.id)
    expect(independentlyIngested.chapters.map((chapter) => chapter.id)).toEqual(
      ingested.chapters.map((chapter) => chapter.id),
    )
    expect(
      independentlyIngested.chapters.flatMap((chapter) =>
        chapter.passages.map((passage) => passage.id),
      ),
    ).toEqual(ingested.chapters.flatMap((chapter) => chapter.passages.map((passage) => passage.id)))
  })

  it('extracts assembly metadata, cover bytes, headings, and exclusion provenance', async () => {
    const workspace = await temporaryDirectory('metadata')
    const ingested = await new EpubIngestionAdapter({
      workspaceRoot: workspace,
      repositoryRoot,
    }).ingest({ bytes: await fixture('synthetic-complex') })

    expect(ingested.metadata).toMatchObject({
      title: 'Clockwork Lantern — Synthetic Fixture',
      titles: [
        {
          value: 'Clockwork Lantern — Synthetic Fixture',
          id: 'title-main',
          type: 'main',
          display_sequence: 1,
        },
        {
          value: 'A Metadata and Cover Test',
          id: 'title-subtitle',
          type: 'subtitle',
          display_sequence: 2,
        },
      ],
      authors: ['Fixture Author'],
      creators: [
        {
          value: 'Fixture Author',
          id: 'creator-author',
          role: 'aut',
          file_as: 'Author, Fixture',
        },
        {
          value: 'Fixture Editor',
          id: 'creator-editor',
          role: 'edt',
          file_as: null,
        },
      ],
      language: 'en',
      publisher: 'Example Fixture Press',
      subjects: ['Clockwork fantasy'],
      rights: 'CC0-1.0',
      date: '2026-07-25',
      modified: '2026-07-25T00:00:00Z',
    })
    expect(ingested.chapters[0]).toMatchObject({
      title: 'The Brass Door',
      headings: [expect.objectContaining({ sourceText: 'The Brass Door' })],
    })
    expect(ingested.cover).toMatchObject({
      sourceArchivePath: 'EPUB/images/lantern.svg',
      mediaType: 'image/svg+xml',
    })
    if (!ingested.cover) throw new Error('fixture cover was not extracted')
    const expectedCover = await readFile(
      path.join(fixtureRoot, 'synthetic-complex/EPUB/images/lantern.svg'),
    )
    const storedCover = await readFile(path.join(workspace, ingested.cover.relativePath))
    expect(storedCover).toEqual(expectedCover)
    expect(ingested.cover.sha256).toBe(hash(expectedCover))

    expect(ingested.audit.excludedSourcePassageCount).toBe(0)
    expect(ingested.audit.excludedSpineDocumentCount).toBe(1)
    expect(ingested.audit.nonStoryDocuments).toEqual([
      expect.objectContaining({
        spinePosition: 4,
        sourceArchivePath: 'EPUB/image-page.xhtml',
        title: 'Illustration',
        titleSource: 'document-title',
        classification: 'no-source-passages',
        images: [expect.objectContaining({ alt: 'The unlit brass lantern.' })],
      }),
    ])
    expect(ingested.audit.textExclusions.length).toBeGreaterThan(0)
    expect(new Set(ingested.audit.textExclusions.map((entry) => entry.classification))).toEqual(
      new Set(['layout-whitespace', 'ruby-annotation', 'non-story-markup']),
    )
    for (const exclusion of ingested.audit.textExclusions) {
      expect(exclusion.exactTextSha256).toBe(hash(exclusion.exactText))
      expect(exclusion.locator).toContain('spine[')
      expect(exclusion.reason.length).toBeGreaterThan(0)
    }
    expect(ingested.audit.findings.map((finding) => finding.kind)).toContain(
      'navigation-spine-conflict',
    )
  })

  it('rejects CRC failures, duplicate names, case collisions, and symbolic links', async () => {
    const original = await fixture('synthetic-ncx-only')
    const entry = zipEntryOffsets(original, 'EPUB/one.xhtml')
    expect(() =>
      unzipEpubSafely(original, { ...DEFAULT_EPUB_ARCHIVE_LIMITS, maxEntries: 1 }),
    ).toThrow(/1-entry limit/)

    const badCrc = Uint8Array.from(original)
    const badCrcView = new DataView(badCrc.buffer)
    badCrcView.setUint32(
      entry.central + 16,
      badCrcView.getUint32(entry.central + 16, true) ^ 1,
      true,
    )
    expect(() => extractEpubDeterministically(badCrc)).toThrow(/failed CRC validation/)

    const duplicate = replaceZipEntryName(original, 'EPUB/two.xhtml', 'EPUB/one.xhtml')
    expect(() => extractEpubDeterministically(duplicate)).toThrow(/repeats entry name/)

    const caseCollision = replaceZipEntryName(original, 'EPUB/two.xhtml', 'EPUB/ONE.xhtml')
    expect(() => extractEpubDeterministically(caseCollision)).toThrow(/case-colliding entry names/)

    const symbolicLink = Uint8Array.from(original)
    const symbolicLinkEntry = zipEntryOffsets(symbolicLink, 'EPUB/one.xhtml')
    new DataView(symbolicLink.buffer).setUint32(symbolicLinkEntry.central + 38, 0xa1ff0000, true)
    expect(() => extractEpubDeterministically(symbolicLink)).toThrow(
      /symbolic links are unsupported/,
    )
  })

  it('rejects encrypted resources, mismatched cover bytes, and excessive XML complexity', async () => {
    const ncxEntries = unzipSync(await fixture('synthetic-ncx-only'))
    const encrypted = zipSync({
      ...ncxEntries,
      'META-INF/encryption.xml': strToU8('<encryption/>'),
    })
    expect(() => extractEpubDeterministically(encrypted)).toThrow(
      /encrypted or obfuscated resources.*unsupported/,
    )

    // A malformed SVG cover degrades exactly like a malformed raster cover: no cover, one finding.
    const coverEntries = unzipSync(await fixture('synthetic-complex'))
    coverEntries['EPUB/images/lantern.svg'] = strToU8('not an SVG container')
    const malformedSvgCover = extractEpubDeterministically(zipSync(coverEntries))
    expect(malformedSvgCover.cover).toBeNull()
    expect(
      malformedSvgCover.findings.find((finding) => finding.kind === 'unusable-cover')?.detail,
    ).toMatch(/EPUB\/images\/lantern\.svg: malformed XML/)
    // An unusable cover is decorative: it degrades to no cover plus a review finding rather than
    // making the whole publication un-ingestable.
    const mismatchedMediaEntries = unzipSync(await fixture('synthetic-complex'))
    mismatchedMediaEntries['EPUB/package.opf'] = strToU8(
      new TextDecoder()
        .decode(mismatchedMediaEntries['EPUB/package.opf'])
        .replace('media-type="image/svg+xml"', 'media-type="image/png"'),
    )
    const mismatchedCover = extractEpubDeterministically(zipSync(mismatchedMediaEntries))
    expect(mismatchedCover.cover).toBeNull()
    expect(mismatchedCover.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'unusable-cover',
          locators: ['EPUB/images/lantern.svg'],
          detail: expect.stringContaining('do not match declared media type image/png'),
        }),
      ]),
    )
    // Story text is unaffected.
    expect(mismatchedCover.documents.flatMap((document) => document.passages).length).toBe(15)

    const deeplyNestedEntries = unzipSync(await fixture('synthetic-ncx-only'))
    deeplyNestedEntries['EPUB/one.xhtml'] = strToU8(
      `<html><body><p>${'<i>'.repeat(260)}text${'</i>'.repeat(260)}</p></body></html>`,
    )
    expect(() => extractEpubDeterministically(zipSync(deeplyNestedEntries))).toThrow(
      /256-element depth limit/,
    )

    const excessiveNodeEntries = unzipSync(await fixture('synthetic-ncx-only'))
    excessiveNodeEntries['EPUB/one.xhtml'] = strToU8(
      `<html><head><title>Bounded</title></head><body><p>${'<i/>'.repeat(250_000)}</p></body></html>`,
    )
    expect(() => extractEpubDeterministically(zipSync(excessiveNodeEntries))).toThrow(
      /250000-node limit/,
    )
  })

  it('does not create a partial book record for malformed or corrupt uploads', async () => {
    for (const [name, bytes] of [
      ['malformed-story', await fixture('synthetic-malformed')],
      ['truncated-zip', (await fixture('synthetic-complex')).subarray(0, 80)],
    ] as const) {
      const workspace = await temporaryDirectory(name)
      const adapter = new EpubIngestionAdapter({ workspaceRoot: workspace, repositoryRoot })

      await expect(adapter.ingest({ bytes })).rejects.toMatchObject({
        name: 'EpubIngestionError',
        code: 'INVALID_EPUB',
      })
      expect(await readdir(workspace)).toEqual([])
    }
  })

  it('rejects symlink escapes for staging, books, and the stable book target before writing', async () => {
    const bytes = await fixture('synthetic-ncx-only')
    const bookId = deriveBookId(extractEpubDeterministically(bytes))

    for (const component of ['.staging', 'books', 'book-target'] as const) {
      const workspace = await temporaryDirectory(`symlink-${component}`)
      const escapeDirectory = await temporaryDirectory(`escape-${component}`)
      const sentinel = path.join(escapeDirectory, 'sentinel.txt')
      await writeFile(sentinel, 'untouched')
      if (component === 'book-target') {
        await mkdir(path.join(workspace, 'books'))
        await symlink(escapeDirectory, path.join(workspace, 'books', bookId), 'dir')
      } else {
        await symlink(escapeDirectory, path.join(workspace, component), 'dir')
      }

      const adapter = new EpubIngestionAdapter({ workspaceRoot: workspace, repositoryRoot })
      await expect(adapter.ingest({ bytes })).rejects.toMatchObject({
        code: 'INVALID_WORKSPACE',
      })
      expect(await readFile(sentinel, 'utf8')).toBe('untouched')
      expect(await readdir(escapeDirectory)).toEqual(['sentinel.txt'])
      if (component === '.staging') expect(await exists(path.join(workspace, 'books'))).toBe(false)
      if (component === 'books') expect(await exists(path.join(workspace, '.staging'))).toBe(false)
      if (component === 'book-target') {
        expect(await exists(path.join(workspace, '.staging'))).toBe(false)
      }
    }
  })

  it('rolls back failures on both sides of manifest commit and then permits retry', async () => {
    const bytes = await fixture('synthetic-ncx-only')
    const bookId = deriveBookId(extractEpubDeterministically(bytes))
    for (const point of [
      'after-target-rename',
      'after-manifest-rename',
    ] satisfies readonly StorageCommitPoint[]) {
      const workspace = await temporaryDirectory(`fault-${point}`)
      const adapter = new EpubIngestionAdapter({
        workspaceRoot: workspace,
        repositoryRoot,
        faultInjector(candidate) {
          if (candidate === point) throw new Error(`injected ${point}`)
        },
      })
      await expect(adapter.ingest({ bytes })).rejects.toMatchObject({ code: 'STORAGE_FAILURE' })
      expect(await exists(path.join(workspace, 'books', bookId))).toBe(false)
      expect(await readdir(path.join(workspace, 'books'))).toEqual([])
      expect(await readdir(path.join(workspace, '.staging'))).toEqual([])

      const retried = await new EpubIngestionAdapter({
        workspaceRoot: workspace,
        repositoryRoot,
      }).ingest({ bytes })
      expect(retried.id).toBe(bookId)
      expect(await exists(path.join(workspace, 'books', bookId, 'book.json'))).toBe(true)
    }
  })

  it('fails closed on stored-record conflicts and converges concurrent identical uploads', async () => {
    const bytes = await fixture('synthetic-ncx-only')
    const conflictWorkspace = await temporaryDirectory('conflict')
    const conflictAdapter = new EpubIngestionAdapter({
      workspaceRoot: conflictWorkspace,
      repositoryRoot,
    })
    const ingested = await conflictAdapter.ingest({ bytes })
    const manifestPath = path.join(conflictWorkspace, 'books', ingested.id, 'book.json')
    const tampered = JSON.parse(await readFile(manifestPath, 'utf8')) as StoredEpubIngestion
    Object.assign(tampered.metadata, { title: 'Tampered title' })
    await writeFile(manifestPath, JSON.stringify(tampered))
    await expect(conflictAdapter.ingest({ bytes })).rejects.toMatchObject({
      code: 'STORAGE_CONFLICT',
    })

    const concurrentWorkspace = await temporaryDirectory('concurrent')
    const concurrentAdapter = new EpubIngestionAdapter({
      workspaceRoot: concurrentWorkspace,
      repositoryRoot,
    })
    const [left, right] = await Promise.all([
      concurrentAdapter.ingest({ bytes }),
      concurrentAdapter.ingest({ bytes }),
    ])
    expect(left).toEqual(right)
    expect(await readdir(path.join(concurrentWorkspace, 'books'))).toEqual([left.id])
    expect(await readdir(path.join(concurrentWorkspace, '.staging'))).toEqual([])
  })

  it('rejects a workspace inside the repository before writing a book record', async () => {
    const fakeRepository = await temporaryDirectory('repository')
    const nestedWorkspace = path.join(fakeRepository, 'work')
    const adapter = new EpubIngestionAdapter({
      workspaceRoot: nestedWorkspace,
      repositoryRoot: fakeRepository,
    })

    await expect(adapter.ingest({ bytes: await fixture('synthetic-ncx-only') })).rejects.toEqual(
      expect.objectContaining<Partial<EpubIngestionError>>({ code: 'INVALID_WORKSPACE' }),
    )
    expect(await exists(nestedWorkspace)).toBe(false)
    expect(await readdir(fakeRepository)).toEqual([])
  })
})
