/**
 * Test helper, not a test. Runs one full ingest in its own OS process and reports the outcome as
 * one JSON line on stdout, so contention between genuinely separate processes can be observed.
 *
 * Usage: tsx ingest-book.mts <workspaceRoot> <repositoryRoot> <epubPath> <lockWaitMs>
 */
import { readFile } from 'node:fs/promises'
import { EpubIngestionAdapter, EpubIngestionError } from '../../src/index.js'

const [workspaceRoot, repositoryRoot, epubPath, lockWaitMs] = process.argv.slice(2)
if (!workspaceRoot || !repositoryRoot || !epubPath || !lockWaitMs) {
  process.stdout.write(`${JSON.stringify({ state: 'usage-error' })}\n`)
  process.exit(2)
}

const bytes = new Uint8Array(await readFile(epubPath))
const adapter = new EpubIngestionAdapter({
  workspaceRoot,
  repositoryRoot,
  lockWaitMs: Number(lockWaitMs),
})

try {
  const startedAt = process.hrtime.bigint()
  const ingested = await adapter.ingest({ bytes })
  process.stdout.write(
    `${JSON.stringify({
      state: 'ingested',
      id: ingested.id,
      passages: ingested.chapters.reduce((total, chapter) => total + chapter.passages.length, 0),
      elapsedMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
    })}\n`,
  )
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      state: 'failed',
      code: error instanceof EpubIngestionError ? error.code : 'unknown',
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  )
  process.exit(1)
}
