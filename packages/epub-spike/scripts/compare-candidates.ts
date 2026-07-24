import { createHash } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initEpubFile } from '@lingo-reader/epub-parser'
import { EPub } from 'epub2'
import { extractEpubForSpike } from '../src/extractor.js'
import { buildFixture } from './build-fixtures.js'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const fixtureSource = path.join(
  repositoryRoot,
  'tests/fixtures/epub/synthetic-complex/EPUB/chapter-1.xhtml',
)
const resourceDirectory = '/tmp/light-novel-audiobook-epub-spike-lingo-resources'

function bodyMarkup(xhtml: string): string {
  return xhtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? ''
}

function outputHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function rejected(error: unknown) {
  if (error instanceof Error) {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined
    return {
      status: 'rejected' as const,
      error: { name: error.name, message: error.message, ...(code ? { code } : {}) },
    }
  }
  return { status: 'rejected' as const, error: { name: 'NonError', message: String(error) } }
}

async function captureOutcome<T>(operation: () => Promise<T>) {
  try {
    return { status: 'accepted' as const, output: await operation() }
  } catch (error) {
    return rejected(error)
  }
}

async function observeLingo(complexPath: string, malformedPath: string) {
  await rm(resourceDirectory, { recursive: true, force: true })
  const sourceBody = bodyMarkup(await readFile(fixtureSource, 'utf8'))
  let parser: Awaited<ReturnType<typeof initEpubFile>> | undefined
  try {
    parser = await initEpubFile(complexPath, resourceDirectory)
    const chapter = await parser.loadChapter('chapter-1')
    const relevantOutput = {
      spine: parser.getSpine().map((item) => ({
        id: item.id,
        href: item.href,
        media_type: item.mediaType,
        linear: item.linear,
      })),
      toc: parser.getToc().map((item) => ({
        id: item.id,
        href: item.href,
        label: item.label,
        play_order: item.playOrder,
      })),
      chapter: {
        html: chapter.html,
        css: chapter.css.map((item) => ({ id: item.id, href: item.href })),
      },
    }
    parser.destroy()
    parser = undefined

    const malformedOutcome = await captureOutcome(async () => {
      const malformed = await initEpubFile(malformedPath, resourceDirectory)
      try {
        const loaded = await malformed.loadChapter('broken')
        return { html: loaded.html, css: loaded.css }
      } finally {
        malformed.destroy()
      }
    })
    return {
      relevantOutput,
      malformedOutcome,
      facts: {
        source_access: 'transformed-body-only',
        body_markup_exact: chapter.html === sourceBody,
      },
    }
  } finally {
    parser?.destroy()
    await rm(resourceDirectory, { recursive: true, force: true })
  }
}

async function observeEpub2(complexPath: string, malformedPath: string) {
  const parser = await EPub.createAsync(complexPath)
  const source = await readFile(fixtureSource, 'utf8')
  const raw = await parser.getChapterRawAsync('chapter-1')
  const relevantOutput = {
    spine: parser.flow.map((item: { id: string; href: string; mediaType?: string }) => ({
      id: item.id,
      href: item.href,
      media_type: item.mediaType ?? null,
    })),
    toc: parser.toc.map((item: { id: string; href: string; title?: string; order?: number }) => ({
      id: item.id,
      href: item.href,
      title: item.title ?? null,
      order: item.order ?? null,
    })),
    raw_xhtml: raw,
  }
  const malformedOutcome = await captureOutcome(async () => {
    const malformed = await EPub.createAsync(malformedPath)
    return malformed.getChapterRawAsync('broken')
  })
  return {
    relevantOutput,
    malformedOutcome,
    facts: { source_access: 'raw-xhtml', raw_xhtml_exact: raw === source },
  }
}

async function observeSelected(complexBytes: Uint8Array, malformedBytes: Uint8Array) {
  const relevantOutput = extractEpubForSpike(complexBytes)
  const malformedOutcome = await captureOutcome(async () => extractEpubForSpike(malformedBytes))
  return {
    relevantOutput,
    malformedOutcome,
    facts: { source_access: 'strict-decoded-text-nodes-with-ledger' },
  }
}

function determinismEvidence<
  T extends { relevantOutput: unknown; malformedOutcome: unknown; facts: unknown },
>(first: T, second: T) {
  const outputRun1 = outputHash(first.relevantOutput)
  const outputRun2 = outputHash(second.relevantOutput)
  const malformedRun1 = outputHash(first.malformedOutcome)
  const malformedRun2 = outputHash(second.malformedOutcome)
  return {
    facts: first.facts,
    relevant_output_sha256: { run_1: outputRun1, run_2: outputRun2 },
    malformed_outcome: first.malformedOutcome,
    malformed_outcome_sha256: { run_1: malformedRun1, run_2: malformedRun2 },
    deterministic: outputRun1 === outputRun2 && malformedRun1 === malformedRun2,
  }
}

async function main() {
  const complexPath = await buildFixture('synthetic-complex')
  const malformedPath = await buildFixture('synthetic-malformed')
  const complexBytes = new Uint8Array(await readFile(complexPath))
  const malformedBytes = new Uint8Array(await readFile(malformedPath))

  const lingoFirst = await observeLingo(complexPath, malformedPath)
  const lingoSecond = await observeLingo(complexPath, malformedPath)
  const epub2First = await observeEpub2(complexPath, malformedPath)
  const epub2Second = await observeEpub2(complexPath, malformedPath)
  const selectedFirst = await observeSelected(complexBytes, malformedBytes)
  const selectedSecond = await observeSelected(complexBytes, malformedBytes)

  const evidence = {
    evidence_schema: 2,
    observed_on: '2026-07-24',
    fixtures: [
      'tests/fixtures/epub/synthetic-complex.epub',
      'tests/fixtures/epub/synthetic-malformed.epub',
    ],
    hash_semantics:
      'SHA-256 of JSON serialization of actual structural/chapter output or canonical accepted/rejected outcome.',
    candidates: {
      '@lingo-reader/epub-parser@0.4.6': determinismEvidence(lingoFirst, lingoSecond),
      'epub2@3.0.2': determinismEvidence(epub2First, epub2Second),
      'fflate@0.8.3+saxes@6.0.0+rules@2': {
        ...determinismEvidence(selectedFirst, selectedSecond),
        extraction_sha256: selectedFirst.relevantOutput.extraction_sha256,
      },
    },
  }
  const outputPath = path.join(repositoryRoot, 'docs/evidence/epub-parser-comparison.json')
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(path.relative(repositoryRoot, outputPath))
}

await main()
