import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SaxesParser } from 'saxes'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EpubIngestionAdapter,
  extractEpubDeterministically,
  type StoredEpubIngestion,
} from '../src/index.js'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const fixtureRoot = path.join(repositoryRoot, 'tests/fixtures/epub')
const temporaryDirectories: string[] = []

/** Every accepted fixture whose spine documents are unpacked beside the archive. */
const unpackedFixtures = [
  'synthetic-complex',
  'synthetic-ncx-only',
  'synthetic-missing-nav',
  'synthetic-malformed-nav',
] as const

/**
 * The passage-root vocabulary, restated here from the EPUB content-document rules rather than
 * imported, so this file is an independent statement of the contract and not a mirror of the
 * implementation's control flow.
 */
const passageElements = new Set([
  'address',
  'aside',
  'blockquote',
  'dd',
  'div',
  'dt',
  'figcaption',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'p',
  'pre',
])

type ExpectedRole = 'source' | 'layout-whitespace' | 'ruby-annotation' | 'non-story-markup'

interface IndependentElement {
  readonly name: string
  readonly attributes: Readonly<Record<string, string>>
  lastChildWasText: boolean
}

interface IndependentText {
  text: string
  readonly chain: readonly IndependentElement[]
}

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), `epub-fidelity-${label}-`))
  temporaryDirectories.push(directory)
  return directory
}

async function fixtureBytes(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path.join(fixtureRoot, `${name}.epub`)))
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function isPassageRoot(element: IndependentElement): boolean {
  if (passageElements.has(element.name)) return true
  const typeEntry = Object.entries(element.attributes).find(
    ([key]) => key.split(':').at(-1) === 'type',
  )
  return (typeEntry?.[1] ?? '').split(/\s+/).includes('pagebreak')
}

/**
 * Re-parses a spine document and recovers every `<body>` text node in document order, coalescing
 * adjacent character data the way any XML tree build does: adjacent text and CDATA with no
 * intervening element form one node, and empty runs are not nodes.
 */
function independentBodyText(xml: string): IndependentText[] {
  const parser = new SaxesParser({ xmlns: false, position: false })
  const stack: IndependentElement[] = []
  const records: IndependentText[] = []
  const lastRecordFor = new Map<IndependentElement, IndependentText>()
  let bodyDepth = -1

  parser.on('opentag', (tag) => {
    const localName = tag.name.includes(':') ? (tag.name.split(':').at(-1) ?? tag.name) : tag.name
    const parent = stack.at(-1)
    if (parent) parent.lastChildWasText = false
    stack.push({
      name: localName,
      attributes: tag.attributes as Readonly<Record<string, string>>,
      lastChildWasText: false,
    })
    if (localName === 'body' && bodyDepth < 0) bodyDepth = stack.length
  })

  parser.on('closetag', () => {
    stack.pop()
    if (bodyDepth >= 0 && stack.length < bodyDepth) bodyDepth = -1
    const parent = stack.at(-1)
    if (parent) parent.lastChildWasText = false
  })

  const appendText = (text: string) => {
    const parent = stack.at(-1)
    if (!parent || text.length === 0 || bodyDepth < 0) return
    if (parent.lastChildWasText) {
      const previous = lastRecordFor.get(parent)
      if (previous) {
        previous.text += text
        return
      }
    }
    const record: IndependentText = { text, chain: [...stack] }
    records.push(record)
    lastRecordFor.set(parent, record)
    parent.lastChildWasText = true
  }
  parser.on('text', appendText)
  parser.on('cdata', appendText)

  parser.write(xml).close()
  return records
}

/**
 * Independently decides the role every text node must carry:
 *
 * 1. anything beneath `script`/`style` is non-story markup;
 * 2. anything beneath `rt`/`rp` is a ruby annotation, never story text;
 * 3. otherwise the innermost enclosing passage root owns the text -- and if that root's own story
 *    text (excluding nested roots, markup, and annotations) is blank, the root carries no story, so
 *    its character data is layout whitespace;
 * 4. character data with no enclosing passage root is layout whitespace between roots.
 */
function expectedRoles(
  records: readonly IndependentText[],
): { role: ExpectedRole; text: string }[] {
  const isMarkup = (record: IndependentText): boolean =>
    record.chain.some((element) => element.name === 'script' || element.name === 'style')
  const isAnnotation = (record: IndependentText): boolean =>
    record.chain.some((element) => element.name === 'rt' || element.name === 'rp')
  const owningRoot = (record: IndependentText): IndependentElement | undefined =>
    [...record.chain].reverse().find((element) => isPassageRoot(element))

  const rootStoryText = new Map<IndependentElement, string>()
  for (const record of records) {
    if (isMarkup(record) || isAnnotation(record)) continue
    const root = owningRoot(record)
    if (!root) continue
    rootStoryText.set(root, (rootStoryText.get(root) ?? '') + record.text)
  }

  return records.map((record) => {
    if (isMarkup(record)) return { role: 'non-story-markup', text: record.text }
    if (isAnnotation(record)) return { role: 'ruby-annotation', text: record.text }
    const root = owningRoot(record)
    if (!root) return { role: 'layout-whitespace', text: record.text }
    if (/^\s*$/u.test(rootStoryText.get(root) ?? '')) {
      return { role: 'layout-whitespace', text: record.text }
    }
    return { role: 'source', text: record.text }
  })
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('EPUB source-text fidelity', () => {
  it.each(unpackedFixtures)(
    'independently reproduces the role of every body character of %s',
    async (name) => {
      const extraction = extractEpubDeterministically(await fixtureBytes(name))
      expect(extraction.documents.length).toBeGreaterThan(0)

      for (const document of extraction.documents) {
        const records = independentBodyText(
          await readFile(path.join(fixtureRoot, name, document.path), 'utf8'),
        )
        const expected = expectedRoles(records)

        // Total accounting: the ledger is an exact ordered partition of the document's own
        // character data. Nothing rewritten, omitted, duplicated, invented, or reordered.
        expect(document.text_ledger.map((entry) => entry.text).join('')).toBe(
          records.map((record) => record.text).join(''),
        )

        // Role-by-role equality against the independent classification. This is what makes the
        // next assertion meaningful: comparing passages against the ledger's own `source`-role
        // entries puts extractor output on both sides, so reclassifying a passage as markup and
        // dropping it cancels out and story text disappears silently.
        expect(
          document.text_ledger.map((entry) => ({ role: entry.role, text: entry.text })),
        ).toEqual(expected)

        // Story text is exactly the independently-derived `source` share of that partition.
        expect(document.passages.map((passage) => passage.source_text).join('')).toBe(
          expected
            .filter((entry) => entry.role === 'source')
            .map((entry) => entry.text)
            .join(''),
        )
        for (const passage of document.passages) {
          expect(passage.source_text_sha256).toBe(hash(passage.source_text))
        }
      }
    },
  )

  it('detects a role misclassification that silently omits story text', async () => {
    // Guards the guard. The previous version of this file compared the passage concatenation
    // against the ledger's own `source`-role entries -- extractor output on both sides -- so
    // reclassifying an entry and dropping its passage cancelled out and passed. These assertions
    // pin both that the hole existed and that it is now closed.
    const extraction = extractEpubDeterministically(await fixtureBytes('synthetic-complex'))
    const document = extraction.documents.find((entry) => entry.path === 'EPUB/chapter-1.xhtml')
    if (!document) throw new Error('fixture lost EPUB/chapter-1.xhtml')
    const records = independentBodyText(
      await readFile(path.join(fixtureRoot, 'synthetic-complex/EPUB/chapter-1.xhtml'), 'utf8'),
    )
    const expected = expectedRoles(records)

    const omitted = 'CLOCKWORK LANTERN'
    expect(document.passages.map((passage) => passage.source_text)).toContain(omitted)
    const mutatedLedger = document.text_ledger.map((entry) =>
      entry.role === 'source' && entry.text === omitted
        ? { ...entry, role: 'non-story-markup' as const }
        : entry,
    )
    const mutatedPassages = document.passages
      .filter((passage) => passage.source_text !== omitted)
      .map((passage) => passage.source_text)
      .join('')

    // Total character accounting cannot see it: no character moved, only a label.
    expect(mutatedLedger.map((entry) => entry.text).join('')).toBe(
      records.map((record) => record.text).join(''),
    )
    // The old self-referential comparison still accepts it -- this is the defect being fixed.
    expect(mutatedPassages).toBe(
      mutatedLedger
        .filter((entry) => entry.role === 'source')
        .map((entry) => entry.text)
        .join(''),
    )
    // The independent classification rejects it, on both the roles and the story text.
    expect(mutatedLedger.map((entry) => ({ role: entry.role, text: entry.text }))).not.toEqual(
      expected,
    )
    expect(mutatedPassages).not.toBe(
      expected
        .filter((entry) => entry.role === 'source')
        .map((entry) => entry.text)
        .join(''),
    )
  })

  it.each([
    ['synthetic-ncx-only', { 'EPUB/one.xhtml': ['First.'], 'EPUB/two.xhtml': ['Second.'] }],
    ['synthetic-missing-nav', { 'EPUB/chapter.xhtml': ['Still retained.'] }],
    ['synthetic-malformed-nav', { 'EPUB/chapter.xhtml': ['The spine survives.'] }],
  ] as const)(
    'pins passage boundaries for %s, not just concatenated text',
    async (name, expected) => {
      // Concatenation alone cannot see a merge or split of adjacent passage roots, which would leave
      // every join identical while changing chapter/passage IDs and TTS segmentation.
      const extraction = extractEpubDeterministically(await fixtureBytes(name))
      expect(
        Object.fromEntries(
          extraction.documents.map((document) => [
            document.path,
            document.passages.map((passage) => passage.source_text),
          ]),
        ),
      ).toEqual(expected)
    },
  )

  it('keeps the golden ordered story text byte-identical through storage and reload', async () => {
    const workspace = await temporaryDirectory('golden')
    const bytes = await fixtureBytes('synthetic-complex')
    const ingested = await new EpubIngestionAdapter({
      workspaceRoot: workspace,
      repositoryRoot,
    }).ingest({ bytes })

    // Every non-ASCII codepoint is spelled as an escape on purpose. The fixture carries a
    // decomposed "e" + U+0301, a no-break space, curly quotes, an em dash, an astral emoji, and a
    // CJK ideograph; written literally, a silent Unicode normalization would produce a golden that
    // still looks correct to a reviewer.
    const golden: readonly (readonly [string, string])[] = [
      ['EPUB/chapter-1.xhtml', 'CLOCKWORK LANTERN'],
      ['EPUB/chapter-1.xhtml', '1'],
      ['EPUB/chapter-1.xhtml', 'The Brass Door'],
      ['EPUB/chapter-1.xhtml', 'A & B \u{1f642} e\u0301 \u00a0 end.'],
      ['EPUB/chapter-1.xhtml', '  Keep\tboth\nspaces.  '],
      ['EPUB/chapter-1.xhtml', 'She opened the door\u2014slowly.'],
      ['EPUB/chapter-1.xhtml', 'The mark \u661f glowed.*'],
      ['EPUB/chapter-1.xhtml', 'Figure 1'],
      ['EPUB/chapter-2.xhtml', 'The Brass Door'],
      ['EPUB/chapter-2.xhtml', '\u201cNothing moved,\u201d said Noa.'],
      ['EPUB/chapter-2.xhtml', 'Was this a memory, or a warning?'],
      ['EPUB/notes.xhtml', '* The inventor\u2019s original wording.'],
      ['EPUB/low-text.xhtml', '*'],
      ['EPUB/side-story.xhtml', 'After the Bell'],
      ['EPUB/side-story.xhtml', 'Noa carried the lantern home.'],
    ]

    const flatten = (ingestion: StoredEpubIngestion): (readonly [string, string])[] =>
      ingestion.chapters.flatMap((chapter) =>
        chapter.passages.map((passage) => [chapter.sourceArchivePath, passage.sourceText] as const),
      )

    expect(flatten(ingested)).toEqual(golden)

    // Persisting and reloading must not touch a single character.
    const reloaded = JSON.parse(
      await readFile(path.join(workspace, 'books', ingested.id, 'book.json'), 'utf8'),
    ) as StoredEpubIngestion
    expect(flatten(reloaded)).toEqual(golden)
    expect(reloaded).toEqual(ingested)
  })
})
