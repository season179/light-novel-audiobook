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
const resourceDirectory = path.join(repositoryRoot, 'work/epub-spike-lingo-resources')

function bodyMarkup(xhtml: string): string {
  return xhtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? ''
}

async function observeLingo(complexPath: string, malformedPath: string) {
  await rm(resourceDirectory, { recursive: true, force: true })
  const parser = await initEpubFile(complexPath, resourceDirectory)
  const chapter = await parser.loadChapter('chapter-1')
  const sourceBody = bodyMarkup(await readFile(fixtureSource, 'utf8'))
  const summary = {
    spine_ids: parser.getSpine().map((item) => item.id),
    toc_ids: parser.getToc().map((item) => item.id),
    source_access: 'transformed-body-only',
    body_markup_exact: chapter.html === sourceBody,
  }
  parser.destroy()

  let malformedResult = 'accepted'
  const malformed = await initEpubFile(malformedPath, resourceDirectory)
  try {
    await malformed.loadChapter('broken')
  } catch (error) {
    malformedResult = `rejected: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    malformed.destroy()
    await rm(resourceDirectory, { recursive: true, force: true })
  }
  return { ...summary, malformed_xhtml: malformedResult }
}

async function observeEpub2(complexPath: string, malformedPath: string) {
  const parser = await EPub.createAsync(complexPath)
  const source = await readFile(fixtureSource, 'utf8')
  const raw = await parser.getChapterRawAsync('chapter-1')
  const malformed = await EPub.createAsync(malformedPath)
  let malformedResult = 'accepted'
  try {
    await malformed.getChapterRawAsync('broken')
  } catch (error) {
    malformedResult = `rejected: ${error instanceof Error ? error.message : String(error)}`
  }
  return {
    spine_ids: parser.flow.map((item: { id: string }) => item.id),
    toc_ids: parser.toc.map((item: { id: string }) => item.id),
    source_access: 'raw-xhtml',
    raw_xhtml_exact: raw === source,
    malformed_xhtml: malformedResult,
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
  const selectedFirst = extractEpubForSpike(complexBytes)
  const selectedSecond = extractEpubForSpike(complexBytes)
  let selectedMalformed = 'accepted'
  try {
    extractEpubForSpike(malformedBytes)
  } catch (error) {
    selectedMalformed = `rejected: ${error instanceof Error ? error.message : String(error)}`
  }

  const evidence = {
    evidence_schema: 1,
    observed_on: '2026-07-24',
    fixture: 'tests/fixtures/epub/synthetic-complex.epub',
    candidates: {
      '@lingo-reader/epub-parser@0.4.6': {
        ...lingoFirst,
        repeated_summary_identical: JSON.stringify(lingoFirst) === JSON.stringify(lingoSecond),
      },
      'epub2@3.0.2': {
        ...epub2First,
        repeated_summary_identical: JSON.stringify(epub2First) === JSON.stringify(epub2Second),
      },
      'fflate@0.8.3+saxes@6.0.0+rules@1': {
        spine_ids: selectedFirst.documents.map((document) => document.idref),
        toc_paths: selectedFirst.navigation.epub3_nav_paths,
        source_access: 'strict-decoded-text-nodes-with-ledger',
        extraction_sha256: selectedFirst.extraction_sha256,
        malformed_xhtml: selectedMalformed,
        repeated_summary_identical:
          JSON.stringify(selectedFirst) === JSON.stringify(selectedSecond),
      },
    },
  }
  const outputPath = path.join(repositoryRoot, 'docs/evidence/epub-parser-comparison.json')
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(path.relative(repositoryRoot, outputPath))
}

await main()
