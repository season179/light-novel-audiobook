import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildFixtureArchive } from '../scripts/build-fixtures.js'
import {
  deriveSourcePassageId,
  EXTRACTION_IDENTITY,
  extractEpubForSpike,
} from '../src/extractor.js'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const complexFixture = path.join(repositoryRoot, 'tests/fixtures/epub/synthetic-complex.epub')
const malformedFixture = path.join(repositoryRoot, 'tests/fixtures/epub/synthetic-malformed.epub')
const goldenPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'golden/synthetic-complex.json',
)

async function extract(pathname: string) {
  return extractEpubForSpike(new Uint8Array(await readFile(pathname)))
}

describe('EPUB source-text semantics spike', () => {
  it('rebuilds byte-identical redistributable fixtures', async () => {
    expect(await buildFixtureArchive('synthetic-complex')).toEqual(
      new Uint8Array(await readFile(complexFixture)),
    )
    expect(await buildFixtureArchive('synthetic-malformed')).toEqual(
      new Uint8Array(await readFile(malformedFixture)),
    )
  })

  it('matches the complete golden extraction repeatedly and in spine order', async () => {
    const expected = JSON.parse(await readFile(goldenPath, 'utf8'))
    const runs = await Promise.all(Array.from({ length: 5 }, () => extract(complexFixture)))

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
    const result = await extract(complexFixture)

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
  })

  it('uses half-open Unicode scalar offsets rather than UTF-16 code units', async () => {
    const result = await extract(complexFixture)
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
    const result = await extract(complexFixture)

    expect(result.navigation.conflict).toBe(true)
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
      semantic_hints: ['image-only', 'requires-review'],
      images: [{ alt: 'The unlit brass lantern.' }],
    })
    expect(
      result.documents.find((document) => document.path.endsWith('notes.xhtml'))?.passages[0],
    ).toMatchObject({
      source_text: '* The inventor’s original wording.',
      semantic_hints: ['footnote'],
    })
  })

  it('fails closed on malformed XHTML', async () => {
    const malformedBytes = new Uint8Array(await readFile(malformedFixture))
    expect(() => extractEpubForSpike(malformedBytes)).toThrow(/malformed XML/)
  })

  it('makes parser and extraction-rule versions part of passage IDs', async () => {
    const result = await extract(complexFixture)
    const passage = result.documents[0]?.passages[0]
    expect(passage).toBeDefined()
    if (!passage) return

    expect(
      deriveSourcePassageId(
        result.publication_content_sha256,
        passage.locator,
        passage.source_text_sha256,
      ),
    ).toBe(passage.id)
    expect(
      deriveSourcePassageId(
        result.publication_content_sha256,
        passage.locator,
        passage.source_text_sha256,
        { ...EXTRACTION_IDENTITY, extraction_rules: 'epub-source-text@2' },
      ),
    ).not.toBe(passage.id)
  })
})
