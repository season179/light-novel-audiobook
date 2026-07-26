import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  buildFixtureArchive,
  CANONICAL_ZIP_FILE_ATTRIBUTES,
  CANONICAL_ZIP_OS,
  fixtureNames,
} from '../scripts/build-fixtures.js'
import {
  deriveSourcePassageId,
  EXTRACTION_IDENTITY,
  extractEpubForSpike,
} from '../src/extractor.js'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const fixtureRoot = path.join(repositoryRoot, 'tests/fixtures/epub')
const goldenRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'golden')

function fixturePath(name: string): string {
  return path.join(fixtureRoot, `${name}.epub`)
}

async function extract(name: string) {
  return extractEpubForSpike(new Uint8Array(await readFile(fixturePath(name))))
}

async function readGolden(name: string) {
  return JSON.parse(await readFile(path.join(goldenRoot, name), 'utf8'))
}

function centralDirectoryMetadata(archive: Uint8Array) {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
  let endOffset = -1
  for (
    let offset = archive.length - 22;
    offset >= Math.max(0, archive.length - 65_557);
    offset -= 1
  ) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      endOffset = offset
      break
    }
  }
  if (endOffset < 0) throw new Error('fixture ZIP has no end-of-central-directory record')

  const entryCount = view.getUint16(endOffset + 10, true)
  let offset = view.getUint32(endOffset + 16, true)
  const decoder = new TextDecoder()
  return Array.from({ length: entryCount }, () => {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error(`fixture ZIP has invalid central-directory entry at ${offset}`)
    }
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const localOffset = view.getUint32(offset + 42, true)
    if (view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error(`fixture ZIP has invalid local entry at ${localOffset}`)
    }
    const metadata = {
      name: decoder.decode(archive.subarray(offset + 46, offset + 46 + nameLength)),
      os: view.getUint16(offset + 4, true) >>> 8,
      attrs: view.getUint32(offset + 38, true),
      dos_time: view.getUint16(offset + 12, true),
      dos_date: view.getUint16(offset + 14, true),
      local_dos_time: view.getUint16(localOffset + 10, true),
      local_dos_date: view.getUint16(localOffset + 12, true),
    }
    offset += 46 + nameLength + extraLength + commentLength
    return metadata
  })
}

function thrownMessage(operation: () => unknown): string {
  try {
    operation()
    return '<accepted>'
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

describe('EPUB source-text semantics spike', () => {
  it('rebuilds every redistributable fixture byte-for-byte', async () => {
    for (const name of fixtureNames) {
      expect(await buildFixtureArchive(name)).toEqual(
        new Uint8Array(await readFile(fixturePath(name))),
      )
    }
  })

  it('pins ZIP creator OS, Unix file attributes, and DOS timestamps', async () => {
    for (const name of fixtureNames) {
      const metadata = centralDirectoryMetadata(await buildFixtureArchive(name))
      expect(metadata.length).toBeGreaterThan(0)
      for (const entry of metadata) {
        expect(entry).toMatchObject({
          os: CANONICAL_ZIP_OS,
          attrs: CANONICAL_ZIP_FILE_ATTRIBUTES,
          dos_time: 0,
          dos_date: 0x2821,
          local_dos_time: 0,
          local_dos_date: 0x2821,
        })
      }
    }
  })

  it('matches the complete golden extraction repeatedly and in spine order', async () => {
    const expected = await readGolden('synthetic-complex.json')
    const runs = await Promise.all(Array.from({ length: 5 }, () => extract('synthetic-complex')))

    for (const result of runs) expect(result).toEqual(expected)
    expect(new Set(runs.map((result) => JSON.stringify(result))).size).toBe(1)
    expect(
      runs[0]?.documents.flatMap((document) =>
        document.passages.map((passage) => passage.source_text),
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
  })

  it('partitions decoded body text once and preserves source-node order', async () => {
    const result = await extract('synthetic-complex')

    for (const document of result.documents) {
      const sourceLedger = document.text_ledger
        .filter((entry) => entry.role === 'source')
        .map((entry) => entry.text)
        .join('')
      const passageText = document.passages.map((passage) => passage.source_text).join('')
      expect(sourceLedger).toBe(passageText)
      expect(new Set(document.text_ledger.map((entry) => entry.locator)).size).toBe(
        document.text_ledger.length,
      )
    }

    const allLedger = result.documents.flatMap((document) => document.text_ledger)
    expect(
      allLedger.filter((entry) => entry.role === 'ruby-annotation').map((entry) => entry.text),
    ).toEqual(['(', 'ほし', ')'])
    const scriptAndStyleWhitespace = allLedger.filter(
      (entry) => entry.locator.includes('/script[') || entry.locator.includes('/style['),
    )
    expect(scriptAndStyleWhitespace.length).toBe(2)
    expect(scriptAndStyleWhitespace.every((entry) => entry.role === 'non-story-markup')).toBe(true)
  })

  it('fails closed before nested passage roots can reorder parent-owned text', async () => {
    const expected = await readGolden('adversarial-errors.json')
    const bytes = new Uint8Array(await readFile(fixturePath('synthetic-nested-parent')))
    expect(thrownMessage(() => extractEpubForSpike(bytes))).toBe(expected.nested_parent_text)
  })

  it('captures and flags images that have no source passage anchor', async () => {
    const result = await extract('synthetic-complex')
    const looseImage = result.documents
      .flatMap((document) => document.images)
      .find((image) => image.alt === 'A loose lantern illustration.')

    expect(looseImage).toMatchObject({
      passage_locator: null,
      source_offset: null,
      semantic_hints: ['outside-passage-root', 'requires-review'],
    })
    expect(
      result.findings.find((finding) => finding.kind === 'image-outside-passage-root'),
    ).toBeDefined()
  })

  it('distinguishes navigation states and only reports genuine order conflicts', async () => {
    const cases = Object.fromEntries(
      await Promise.all(
        [
          'synthetic-complex',
          'synthetic-ncx-only',
          'synthetic-missing-nav',
          'synthetic-malformed-nav',
        ].map(async (name) => {
          const result = await extract(name)
          return [
            name,
            {
              navigation: result.navigation,
              finding_kinds: result.findings.map((finding) => finding.kind),
              source_text: result.documents.flatMap((document) =>
                document.passages.map((passage) => passage.source_text),
              ),
            },
          ]
        }),
      ),
    )
    expect(cases).toEqual(await readGolden('navigation-cases.json'))
  })

  it('uses half-open Unicode scalar offsets rather than UTF-16 code units', async () => {
    const result = await extract('synthetic-complex')
    const entityPassage = result.documents[0]?.passages.find((passage) =>
      passage.source_text.includes('🙂'),
    )
    const emphasis = entityPassage?.annotations.find((annotation) => annotation.kind === 'emphasis')

    expect(emphasis).toMatchObject({ start: 6, end: 10, offset_unit: 'unicode-scalar-value' })
    expect(
      Array.from(entityPassage?.source_text ?? '')
        .slice(emphasis?.start, emphasis?.end)
        .join(''),
    ).toBe('🙂 é')
    expect((entityPassage?.source_text ?? '').slice(emphasis?.start, emphasis?.end)).not.toBe(
      '🙂 é',
    )
  })

  it('retains and flags content instead of silently dropping it', async () => {
    const result = await extract('synthetic-complex')

    expect(result.navigation.conflict).toBe(true)
    expect(result.navigation.conflict_sources).toEqual(['epub3-nav', 'ncx'])
    expect(result.findings.map((finding) => finding.kind)).toContain('duplicate-heading')
    expect(
      result.documents.find((document) => document.path.endsWith('side-story.xhtml')),
    ).toMatchObject({
      linear: false,
      semantic_hints: ['nonlinear-spine-item', 'requires-review'],
    })
    expect(
      result.documents.find((document) => document.path.endsWith('image-page.xhtml')),
    ).toMatchObject({
      semantic_hints: expect.arrayContaining(['image-only', 'requires-review']),
      images: [{ alt: 'The unlit brass lantern.' }],
    })
    expect(
      result.documents.find((document) => document.path.endsWith('notes.xhtml'))?.passages[0],
    ).toMatchObject({
      source_text: '* The inventor’s original wording.',
      semantic_hints: ['footnote'],
    })
  })

  it('fails closed on malformed story XHTML', async () => {
    const bytes = new Uint8Array(await readFile(fixturePath('synthetic-malformed')))
    expect(() => extractEpubForSpike(bytes)).toThrow(/malformed XML/)
  })

  it('rejects unsafe unreferenced ZIP entry names before EPUB processing', async () => {
    const expected = await readGolden('adversarial-errors.json')
    const safeEntries = unzipSync(new Uint8Array(await readFile(fixturePath('synthetic-ncx-only'))))
    const actual = Object.fromEntries(
      Object.keys(expected.unsafe_zip_entries).map((entryName) => {
        const archive = zipSync({ ...safeEntries, [entryName]: strToU8('unreferenced') })
        return [entryName, thrownMessage(() => extractEpubForSpike(archive))]
      }),
    )
    expect(actual).toEqual(expected.unsafe_zip_entries)
  })

  it('serializes named parser/rule identity fields independently of insertion order', async () => {
    const result = await extract('synthetic-complex')
    const passage = result.documents[0]?.passages[0]
    expect(passage).toBeDefined()
    if (!passage) return

    const reorderedIdentity = {
      cover_rules: EXTRACTION_IDENTITY.cover_rules,
      extraction_rules: EXTRACTION_IDENTITY.extraction_rules,
      archive_parser: EXTRACTION_IDENTITY.archive_parser,
      xml_parser: EXTRACTION_IDENTITY.xml_parser,
    }
    expect(
      deriveSourcePassageId(
        result.publication_content_sha256,
        passage.locator,
        passage.source_text_sha256,
        reorderedIdentity,
      ),
    ).toBe(passage.id)
    expect(
      deriveSourcePassageId(
        result.publication_content_sha256,
        passage.locator,
        passage.source_text_sha256,
        { ...EXTRACTION_IDENTITY, cover_rules: 'm4b-raster-cover@2' },
      ),
    ).toBe(passage.id)
    expect(
      deriveSourcePassageId(
        result.publication_content_sha256,
        passage.locator,
        passage.source_text_sha256,
        { ...EXTRACTION_IDENTITY, extraction_rules: 'epub-source-text@3' },
      ),
    ).not.toBe(passage.id)
  })
})
