#!/usr/bin/env node
/**
 * Issue #84 real browser-transport proof. It deliberately starts from a full two-chapter upload,
 * requests an offset chapter plus a strict passage cap, then persists a differently bounded job
 * from the same upload. No source text leaves the scratch workspace.
 */
import { createHash, randomUUID } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import { ACCEPTANCE_M1_EPUB_PATH } from './build-acceptance-m1-epub.mjs'
import {
  createServerFnClient,
  discoverServerFunctions,
  loadSeroval,
  pollJobUntil,
  resolveHarnessWorkspace,
  runPreflight,
  startDevServer,
  stopDevServer,
  waitForHttp,
} from './proof-m1.mjs'

const SLICE_A = Object.freeze({
  firstChapter: 2,
  maxChapters: 1,
  maxPassagesPerChapter: 3,
})
const SLICE_B = Object.freeze({ maxChapters: 1, maxPassagesPerChapter: 2 })
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const fail = (message) => {
  throw new Error(message)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const parseArgs = () => {
  const options = { workspace: undefined, port: 3000, evidence: undefined }
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index]
    const take = () => {
      const value = process.argv[index + 1]
      if (value === undefined) fail(`${argument} needs a value`)
      index += 1
      return value
    }
    if (argument === '--workspace') options.workspace = take()
    else if (argument === '--port') options.port = Number(take())
    else if (argument === '--evidence') options.evidence = take()
    else fail(`unknown argument: ${argument}`)
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
    fail('port must be a valid integer')
  }
  return options
}

const findFiles = async (root, name) => {
  const files = []
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const candidate = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(candidate)
      else if (entry.name === name) files.push(candidate)
    }
  }
  await walk(root)
  return files
}

const persistedJob = (db, jobId) => {
  const row = db.prepare('SELECT snapshot_json FROM jobs WHERE id = ?').get(jobId)
  if (row === undefined) fail(`missing persisted job ${jobId}`)
  return JSON.parse(row.snapshot_json)
}

const persistedWindow = (db, jobId) => {
  const snapshot = persistedJob(db, jobId)
  if (snapshot.bookId === null) fail(`job ${jobId} has no persisted book`)
  const bookId = snapshot.bookId
  const chapterIds = db
    .prepare('SELECT id FROM chapters WHERE book_id = ? ORDER BY position')
    .all(bookId)
    .map((row) => row.id)
  const passageIds = db
    .prepare(
      'SELECT p.id FROM source_passages p JOIN chapters c ON c.id = p.chapter_id WHERE c.book_id = ? ORDER BY p.id',
    )
    .all(bookId)
    .map((row) => row.id)
  const segmentIds = db
    .prepare(
      'SELECT s.id FROM segments s JOIN chapters c ON c.id = s.chapter_id WHERE c.book_id = ? ORDER BY s.id',
    )
    .all(bookId)
    .map((row) => row.id)
  const artifacts = db
    .prepare(
      `SELECT a.segment_id, a.sha256, a.byte_length, a.created_at
         FROM artifacts a JOIN segments s ON s.id = a.segment_id
         JOIN chapters c ON c.id = s.chapter_id
        WHERE c.book_id = ? ORDER BY a.segment_id`,
    )
    .all(bookId)
    .map((row) => ({
      segmentId: row.segment_id,
      sha256: row.sha256,
      byteLength: row.byte_length,
      createdAt: row.created_at,
    }))
  const outputs = db
    .prepare('SELECT COUNT(*) AS count FROM completed_outputs WHERE job_id = ?')
    .get(jobId)
  return {
    jobId,
    state: snapshot.state,
    stage: snapshot.stage,
    commandIdentity: snapshot.commandIdentity,
    bookId,
    chapterIds,
    passageIds,
    segmentIds,
    artifacts,
    completedOutputs: outputs.count,
  }
}

const sameRecords = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const disjoint = (left, right) => left.every((value) => !new Set(right).has(value))

const options = parseArgs()
const workspace = await resolveHarnessWorkspace(
  options.workspace ?? path.join(tmpdir(), `lna-84-real-slice-${randomUUID()}`),
  'real-slice',
)
const config = {
  transports: 'real',
  epub: ACCEPTANCE_M1_EPUB_PATH,
  port: options.port,
  workspace,
  expectedChapters: 1,
}
console.log(`[slice-proof] workspace=${workspace}`)
const realEnv = await runPreflight(config)
const baseUrl = `http://127.0.0.1:${config.port}`
const childEnv = {
  ...process.env,
  LNA_WEB_TRANSPORTS: 'real',
  AUDIOBOOK_WORKSPACE_DIR: workspace,
  LNA_REVIEWER: process.env.LNA_REVIEWER ?? 'Issue 84 Real Slice Proof',
  ...realEnv,
}
const serverLog = path.join(workspace, 'dev-server.log')
let server = startDevServer(childEnv, serverLog, config.port)
let sliceABefore

try {
  await waitForHttp(baseUrl, server, 120_000, 'slice proof server start')
  let client = createServerFnClient(
    baseUrl,
    await loadSeroval(),
    await discoverServerFunctions(baseUrl),
  )
  const form = new FormData()
  form.set('file', new Blob([config.epubBytes]), path.basename(config.epub))
  const upload = await client.call('uploadEpubFn', form, 'slice-upload')

  const startedA = await client.call(
    'startGenerationFn',
    { uploadId: upload.uploadId, slice: SLICE_A },
    'slice-a-start',
  )
  if (!startedA.jobId.includes('slice-firstChapter=2,maxChapters=1,maxPassagesPerChapter=3')) {
    fail(`slice A job identity omitted its canonical descriptor: ${startedA.jobId}`)
  }
  const directedA = await pollJobUntil(
    client,
    startedA.jobId,
    (view) => (view.state === 'awaiting_review' || view.state === 'completed' ? view : undefined),
    { timeoutMs: 20 * 60_000, label: 'slice A direction' },
  )
  if (directedA.state === 'awaiting_review') {
    const review = await client.call('listFallbackReviewFn', { jobId: startedA.jobId })
    console.log(`[slice-proof] slice A review decisions=${review.pendingCount}`)
    await client.call('approveAllFallbacksFn', { jobId: startedA.jobId })
    await client.call('renderApprovedScriptFn', { jobId: startedA.jobId })
  }
  const completedA = await pollJobUntil(
    client,
    startedA.jobId,
    (view) => (view.state === 'completed' ? view : undefined),
    { timeoutMs: 20 * 60_000, label: 'slice A render' },
  )
  if (completedA.totalSegments !== 3 || completedA.completedSegments !== 3) {
    fail(
      `slice A rendered ${completedA.completedSegments}/${completedA.totalSegments}, expected 3/3`,
    )
  }

  const dbPath = path.join(workspace, 'audiobook.db')
  const beforeDb = new DatabaseSync(dbPath, { readOnly: true })
  sliceABefore = persistedWindow(beforeDb, startedA.jobId)
  beforeDb.close()

  // Restart the web process between jobs. This gives the second slice a fresh per-process model
  // lifecycle while deliberately preserving the same upload, SQLite rows, and HTTP protocol.
  await stopDevServer(server)
  server = startDevServer(childEnv, serverLog, config.port)
  await waitForHttp(baseUrl, server, 120_000, 'slice proof server restart')
  client = createServerFnClient(
    baseUrl,
    await loadSeroval(),
    await discoverServerFunctions(baseUrl),
  )
  let directedB
  let startedB
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    startedB = await client.call(
      'startGenerationFn',
      { uploadId: upload.uploadId, slice: SLICE_B },
      `slice-b-start-${attempt}`,
    )
    if (
      startedB.jobId === startedA.jobId ||
      !startedB.jobId.includes('slice-maxChapters=1,maxPassagesPerChapter=2')
    ) {
      fail('differently bounded slice did not receive a distinct canonical persisted identity')
    }
    const outcome = await pollJobUntil(
      client,
      startedB.jobId,
      (view) =>
        ['awaiting_review', 'completed', 'failed'].includes(view.state) ? view : undefined,
      {
        timeoutMs: 20 * 60_000,
        label: `slice B direction attempt ${attempt}`,
        expectFailed: true,
      },
    )
    if (outcome.state !== 'failed') {
      directedB = outcome
      break
    }
    console.log(
      `[slice-proof] slice B transiently failed; retrying once through the same HTTP call`,
    )
    await sleep(3_000)
  }
  if (directedB === undefined) fail('slice B did not persist a directed script after one retry')
  console.log(`[slice-proof] slice B persisted at state=${directedB.state}`)
  await sleep(500)
} finally {
  await stopDevServer(server).catch(() => undefined)
}

const db = new DatabaseSync(path.join(workspace, 'audiobook.db'), { readOnly: true })
const jobIds = db
  .prepare('SELECT id FROM jobs ORDER BY id')
  .all()
  .map((row) => row.id)
const sliceA = persistedWindow(
  db,
  jobIds.find((jobId) => jobId.includes('firstChapter=2')) ?? fail('slice A row missing'),
)
const sliceB = persistedWindow(
  db,
  jobIds.find((jobId) => jobId.includes('maxChapters=1,maxPassagesPerChapter=2')) ??
    fail('slice B row missing'),
)
db.close()

const bookJsonFiles = await findFiles(workspace, 'book.json')
if (bookJsonFiles.length !== 1)
  fail(`expected one full extraction record, found ${bookJsonFiles.length}`)
const extracted = JSON.parse(await readFile(bookJsonFiles[0], 'utf8'))
const extractedChapters = extracted.chapters.length
const extractedPassages = extracted.chapters.reduce(
  (total, chapter) => total + chapter.passages.length,
  0,
)

if (extractedChapters !== 2 || extractedPassages !== 20) {
  fail(`full extraction shape changed: ${extractedChapters} chapters/${extractedPassages} passages`)
}
if (
  sliceA.chapterIds.length !== 1 ||
  !sliceA.chapterIds[0].endsWith('-ch0002') ||
  sliceA.passageIds.length !== 3 ||
  sliceA.segmentIds.length !== 3 ||
  sliceA.artifacts.length !== 3 ||
  sliceA.completedOutputs !== 1
) {
  fail('slice A persisted coverage does not equal requested chapter 2 / three-passage window')
}
if (
  sliceB.chapterIds.length !== 1 ||
  !sliceB.chapterIds[0].endsWith('-ch0001') ||
  sliceB.passageIds.length !== 2 ||
  sliceB.segmentIds.length !== 2
) {
  fail('slice B persisted coverage does not equal its distinct chapter 1 / two-passage window')
}
if (
  sliceA.bookId === sliceB.bookId ||
  !disjoint(sliceA.chapterIds, sliceB.chapterIds) ||
  !disjoint(sliceA.passageIds, sliceB.passageIds) ||
  !disjoint(sliceA.segmentIds, sliceB.segmentIds)
) {
  fail('differently bounded slices collided in persisted book/script rows')
}
if (sliceABefore === undefined) fail('slice A pre-collision receipt was not captured')

const result = {
  schema: 'issue-84-real-slice-proof@1',
  fixture: {
    bytes: config.epubBytes.byteLength,
    sha256: sha256(config.epubBytes),
    extractedChapters,
    extractedPassages,
  },
  requestedSlice: SLICE_A,
  sliceA,
  collisionSlice: SLICE_B,
  sliceB,
  persistedJobIds: jobIds,
  collisionChecks: {
    distinctJobIds: sliceA.jobId !== sliceB.jobId,
    distinctBookIds: sliceA.bookId !== sliceB.bookId,
    disjointChapterIds: disjoint(sliceA.chapterIds, sliceB.chapterIds),
    disjointPassageIds: disjoint(sliceA.passageIds, sliceB.passageIds),
    disjointSegmentIds: disjoint(sliceA.segmentIds, sliceB.segmentIds),
    sliceAArtifactRowsUnchanged: sameRecords(sliceABefore.artifacts, sliceA.artifacts),
  },
  distinguishingEvidence:
    'the same workspace full-extraction record contains 2 chapters/20 passages, while the offset bounded job persisted and rendered only original chapter 2 with 3 passages; both chapter selection and passage cap would fail independently if bounds were dropped',
}
if (!result.collisionChecks.sliceAArtifactRowsUnchanged) {
  fail('slice B changed slice A artifact rows')
}
const evidencePath = path.resolve(options.evidence ?? path.join(workspace, 'slice-proof.json'))
await writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
console.log(`[slice-proof] evidence=${evidencePath}`)
console.log('[slice-proof] GREEN: HTTP bounds, persisted coverage, and collision isolation proven')
