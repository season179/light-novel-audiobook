#!/usr/bin/env node
/**
 * listening-run — render a bounded slice of the user's own EPUB into a numbered M4B they can sit
 * and listen to, via `pnpm pipeline:demo -- --transports real`, and leave a short listening README
 * next to the output.
 *
 *   scripts/listening-run.sh --epub <path> [options]
 *
 * Options:
 *   --epub <path>                     The EPUB to render. Required; never opened by this script.
 *   --workspace <dir>                 Workspace root. Default: a fresh directory under the OS temp
 *                                     dir. An existing directory is accepted only if it holds a
 *                                     previous run's audiobook.db (a deliberate resume).
 *   --job-id <id>                     Default: listening-<timestamp>.
 *   --from-chapter <n>                First domain chapter (1-based). Default: 1.
 *   --chapters <n>                    Chapters to render. Default: 2.
 *   --max-passages-per-chapter <n>    Safety bound per chapter. Default: 300.
 *   --reviewer <name>                 Actor recorded on the fallback review decision.
 *                                     Default: LNA_REVIEWER, else "Listening run (scripted)".
 *   --dry-run                         Print the resolved configuration and stop.
 *
 * SANITIZATION CONTRACT — this book is copyrighted and the repo is public. Every log line and
 * every byte of the listening README carries counts, hashes, durations, byte sizes and structure
 * only: never story text, dialogue, chapter titles, or character names. The one unavoidable
 * exception is that output file PATHS embed the book-title slug (the product names outputs after
 * the book) and the README must name the M4B path to be useful; nothing else about the book's
 * content or metadata values is printed. ffprobe marker titles and container metadata values are
 * read for verification but always withheld from output.
 */
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { appendFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {
  assertGpuIdle,
  assertNoModelProcesses,
  checkRealRuntimePaths,
  elapsedMs,
  fail,
  HarnessFailure,
  listModelProcesses,
  log,
  pathStats,
  REPOSITORY_ROOT,
  resolveRealRuntimePaths,
  resolveSafeWorkspace,
  runCheck,
  runChecked,
  sha256File,
} from './proof-m1-lib.mjs'

const SCRIPT_VERSION = 'listening-run@1'
const DEFAULT_CHAPTERS = 2
const DEFAULT_MAX_PASSAGES = 300

// ----------------------------------------------------------------------------- argument parsing

const parseArgs = (argv) => {
  const options = {
    epub: undefined,
    workspace: undefined,
    jobId: undefined,
    fromChapter: 1,
    chapters: DEFAULT_CHAPTERS,
    maxPassages: DEFAULT_MAX_PASSAGES,
    reviewer: undefined,
    transports: 'real',
    dryRun: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const takeValue = () => {
      const value = argv[index + 1]
      if (value === undefined) fail(`${arg} needs a value`)
      index += 1
      return value
    }
    if (arg === '--epub') options.epub = takeValue()
    else if (arg === '--workspace') options.workspace = takeValue()
    else if (arg === '--job-id') options.jobId = takeValue()
    else if (arg === '--from-chapter') options.fromChapter = Number(takeValue())
    else if (arg === '--chapters') options.chapters = Number(takeValue())
    else if (arg === '--max-passages-per-chapter') options.maxPassages = Number(takeValue())
    else if (arg === '--reviewer') options.reviewer = takeValue()
    else if (arg === '--transports') options.transports = takeValue()
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--help' || arg === '-h') {
      console.log('scripts/listening-run.sh --epub <path> [--workspace DIR] [--job-id ID]')
      console.log('  [--from-chapter N] [--chapters N] [--max-passages-per-chapter N]')
      console.log('  [--reviewer NAME] [--dry-run]')
      console.log('  [--transports real|fake] (default real; fake is the no-GPU self-test)')
      process.exit(0)
    } else {
      fail(`unknown argument: ${arg}`)
    }
  }
  if (options.epub === undefined) {
    fail(
      '--epub is required (the script never defaults to any book; pass the EPUB path explicitly)',
    )
  }
  if (options.transports !== 'real' && options.transports !== 'fake') {
    fail(`--transports must be real or fake, got ${JSON.stringify(options.transports)}`)
  }
  for (const name of ['fromChapter', 'chapters', 'maxPassages']) {
    if (!Number.isSafeInteger(options[name]) || options[name] < 1) {
      fail(`--${name} must be a positive integer, got ${String(options[name])}`)
    }
  }
  return options
}

// --------------------------------------------------------------------------- driver subprocess

/**
 * Runs one pnpm command as its own process group with output tee'd to a private log file, and
 * always reaps the group. The driver's own output is sanitized by design (audited: counts,
 * hashes, paths and rule messages only — see the report); stderr is streamed through, stdout is
 * buffered for the caller to parse. A content-free command receipt is appended after every actual
 * invocation so review-path acceptance can distinguish a branch that ran from one silently skipped.
 */
const runPnpmScript = async ({ args, env, logFile, streamStderr = true }) => {
  const child = spawn('pnpm', args, {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stream = createWriteStream(logFile, { flags: 'a' })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk
    stream.write(chunk)
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
    stream.write(chunk)
    if (streamStderr) process.stderr.write(chunk)
  })
  const exitCode = await new Promise((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise)
    child.once('close', (code) => resolvePromise(code ?? 1))
  }).finally(() => {
    stream.end()
  })
  const separator = args.indexOf('--')
  const segmentFlag = args.indexOf('--segment-id')
  await appendFile(
    path.join(path.dirname(logFile), 'listening-run-commands.jsonl'),
    `${JSON.stringify({
      command: args[0],
      action: args[0] === 'pipeline:review' ? args[separator + 1] : 'run',
      segmentId: segmentFlag === -1 ? null : args[segmentFlag + 1],
      exitCode,
    })}\n`,
  )
  return { exitCode, stdout, stderr, kill: () => killGroup(child) }
}

const killGroup = (child) => {
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    // already gone
  }
}

// ----------------------------------------------------------------------------- review gate

const REVIEW_GATE_ERROR = 'PendingFallbackReviewError'

const parseReviewList = (stdout) => {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
  const header = lines.find((line) => line.status === 'pending-fallback-review')
  const items = lines.filter(
    (line) => line.status === 'pending-item' || line.status === 'excluded-item',
  )
  if (header === undefined) fail('review list did not return the expected summary line')
  return { pendingCount: header.pendingCount, excludedCount: header.excludedCount, items }
}

const groupKey = (item) =>
  JSON.stringify([item.speakerId, item.fallbackReason, item.proposedVoiceProfileId])

/**
 * Walks the fallback review gate through the driver's own review CLI, recording the configured
 * reviewer as the actor — the same one-explicit-decision step the browser proof makes, over the
 * sanctioned command path. Prints counts only; the CLI's item lines never carry prose.
 */
const walkReviewGate = async ({ workspace, jobId, reviewer, logFile }) => {
  const list = await runPnpmScript({
    args: ['pipeline:review', '--', 'list', '--workspace', workspace, '--job-id', jobId],
    env: {},
    logFile,
    streamStderr: false,
  })
  if (list.exitCode !== 0) fail(`review list failed; see ${logFile}`)
  const { pendingCount, excludedCount, items } = parseReviewList(list.stdout)
  const pending = items.filter((item) => item.decision === 'pending')
  const groups = new Map()
  for (const item of pending) {
    const key = groupKey(item)
    groups.set(key, (groups.get(key) ?? 0) + 1)
  }
  log(
    `[review] gate reached: ${pendingCount} pending decision(s) in ${groups.size} decision group(s)` +
      `${excludedCount > 0 ? `, ${excludedCount} previously withdrawn` : ''} — approving as ${reviewer}`,
  )

  const env = { LNA_REVIEWER: reviewer }
  if (groups.size === 1 && excludedCount === 0) {
    const approved = await runPnpmScript({
      args: ['pipeline:review', '--', 'approve', '--workspace', workspace, '--job-id', jobId],
      env,
      logFile,
      streamStderr: false,
    })
    if (approved.exitCode !== 0) fail(`book-wide review approval failed; see ${logFile}`)
    const summary = approved.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line))
      .find((line) => line.status === 'approved')
    log(
      `[review] book-wide approval recorded: ${summary?.approvedCount ?? '?'} segment(s) authorized`,
    )
    return
  }

  // Heterogeneous groups (or a withdrawal to clear): the CLI's book-wide grant is deliberately
  // refused for those, so decide per segment — the same explicit decision, one record each.
  log(
    `[review] decisions are not one homogeneous group; approving ${items.length} segment(s) individually`,
  )
  let decided = 0
  for (const item of items) {
    const approved = await runPnpmScript({
      args: [
        'pipeline:review',
        '--',
        'approve',
        '--workspace',
        workspace,
        '--job-id',
        jobId,
        '--segment-id',
        item.segmentId,
      ],
      env,
      logFile,
      streamStderr: false,
    })
    if (approved.exitCode !== 0) fail(`per-segment review approval failed; see ${logFile}`)
    decided += 1
    if (decided % 10 === 0 || decided === items.length) {
      log(`[review] ${decided}/${items.length} segment decision(s) recorded`)
    }
  }
}

// ----------------------------------------------------------------------------- ffprobe summary

const TAG_VALUE_ALLOWLIST = new Set([
  'major_brand',
  'minor_version',
  'compatible_brands',
  'encoder',
])

/**
 * Container facts for the listening README. Chapter marker titles and book metadata values are
 * read for verification but NEVER returned — only spans, counts, tag keys and technical values.
 */
const probeAudiobook = (ffprobePath, m4bPath, expectedChapters) => {
  const raw = runChecked(
    ffprobePath,
    ['-v', 'error', '-show_format', '-show_streams', '-show_chapters', '-of', 'json', m4bPath],
    'ffprobe audiobook inspection',
  )
  const probe = JSON.parse(raw)
  const streams = (probe.streams ?? []).map((stream) => ({
    codecType: stream.codec_type,
    codecName: stream.codec_name,
    channels: stream.channels,
    sampleRate: stream.sample_rate === undefined ? undefined : Number(stream.sample_rate),
    attachedPic: stream.disposition?.attached_pic === 1,
  }))
  const audio = streams.find((stream) => stream.codecType === 'audio')
  if (audio === undefined) fail('ffprobe: the M4B has no audio stream')
  if (audio.codecName !== 'aac') fail(`ffprobe: M4B audio codec is ${audio.codecName}, not aac`)
  const cover = streams.find((stream) => stream.codecType === 'video' || stream.attachedPic)

  const markers = (probe.chapters ?? []).map((chapter) => ({
    startMs: Math.round(Number(chapter.start_time) * 1000),
    endMs: Math.round(Number(chapter.end_time) * 1000),
  }))
  if (markers.length !== expectedChapters) {
    fail(
      `ffprobe: the M4B carries ${markers.length} chapter marker(s), expected ${expectedChapters}`,
    )
  }
  const durationMs = Math.round(Number(probe.format.duration) * 1000)
  let cursor = 0
  for (const [index, marker] of markers.entries()) {
    if (marker.startMs < cursor || marker.endMs <= marker.startMs) {
      fail(`ffprobe: chapter marker ${index + 1} is not an ordered positive span`)
    }
    cursor = marker.endMs
  }
  if (Math.abs(durationMs - cursor) > 2_000) {
    fail(`ffprobe: chapter markers end at ${cursor}ms but the stream is ${durationMs}ms`)
  }

  const tags = probe.format.tags ?? {}
  const tagSummary = Object.keys(tags)
    .sort()
    .map((key) =>
      TAG_VALUE_ALLOWLIST.has(key.toLowerCase()) ? `${key}=${tags[key]}` : `${key}=<withheld>`,
    )

  return {
    durationSeconds: Math.round(Number(probe.format.duration) * 100) / 100,
    audio,
    cover: cover === undefined ? null : { codecName: cover.codecName },
    chapterMarkers: markers,
    tagSummary,
  }
}

// ----------------------------------------------------------------------------- listening README

const versionLabelOf = (m4bPath) => /-v(\d{3})\.m4b$/u.exec(m4bPath)?.[1]

const writeListeningReadme = async ({
  report,
  probe,
  workspace,
  jobId,
  reviewer,
  gateApproved,
  transports,
  slice,
  resolvedEnv,
  epubSha256,
  epubBytes,
}) => {
  const version = versionLabelOf(report.m4bPath)
  if (version === undefined)
    fail(`could not read the output version from ${path.basename(report.m4bPath)}`)
  // Versioned and never overwritten: a new output version gets its own note, and a rerun that
  // produced no new output version gets a timestamped variant rather than touching the first.
  let readmePath = path.join(path.dirname(report.m4bPath), `LISTENING-v${version}.md`)
  if ((await pathStats(readmePath)) !== undefined) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    readmePath = path.join(path.dirname(report.m4bPath), `LISTENING-v${version}-${stamp}.md`)
  }
  const lines = [
    `# Listening run — bounded-slice audiobook (v${version})`,
    '',
    `Generated ${new Date().toISOString()} by ${SCRIPT_VERSION}. Counts, hashes, durations, byte`,
    'sizes and structure only: this note deliberately contains no story text, dialogue, chapter',
    'titles, or character names. (File paths embed the book-title slug because the product names',
    'outputs after the book; nothing else about the content appears here.)',
    '',
    '## The audiobook',
    '',
    `- **M4B:** \`${report.m4bPath}\` — ${report.m4bBytes} bytes, sha256 ${report.m4bSha256}`,
    `- Duration: ${probe.durationSeconds}s; chapter markers: ${probe.chapterMarkers.length}, ordered spans covering the stream`,
    `- Cover stream: ${probe.cover === null ? 'none' : `present (${probe.cover.codecName})`}`,
    `- Container tag keys: ${probe.tagSummary.length === 0 ? 'none' : probe.tagSummary.join(', ')}`,
    '  (book metadata values are withheld from this note by policy; players read them from the file itself)',
    '- Chapter audio:',
    ...report.chapterOutputs.map(
      (chapter, index) => `  ${index + 1}. \`${chapter.path}\` — ${chapter.bytes} bytes`,
    ),
    '',
    '## The run',
    '',
    `- Job: \`${jobId}\` in workspace \`${workspace}\``,
    `- EPUB: ${epubBytes} bytes, sha256 ${epubSha256} (content never opened by the script)`,
    `- Slice: from chapter ${slice.fromChapter}, at most ${slice.chapters} chapter(s), at most ${slice.maxPassages} passages per chapter`,
    `- Slice: from chapter ${slice.fromChapter}, at most ${slice.chapters} chapter(s), at most ${slice.maxPassages} passages per chapter`,
    `- Extraction: ${
      report.slice === undefined
        ? 'not re-emitted (the driver replayed an already-completed job; counts above are the reuse ledger)'
        : `${report.slice.extractedChapters} chapter(s)/${report.slice.extractedPassages} passage(s) in the book, ${report.slice.slicedChapters} chapter(s)/${report.slice.slicedPassages} passage(s) kept`
    }`,
    `- Segments: ${report.generatedSegments} rendered, ${report.reusedSegments} reused from earlier runs`,
    `- Fallback voice: ${report.fallbackWarnings} segment(s) used the fallback voice (no cast is approved for this book${
      gateApproved
        ? `; the review gate was approved once by ${reviewer})`
        : '; this slice needed no review stop)'
    }`,
    '',
    '## How to listen',
    '',
    '1. Easiest: open the M4B path above in any audiobook player.',
    '2. In the app (the job and its audio are already in this workspace):',
    '',
    '   ```sh',
    `   LNA_WEB_TRANSPORTS=${transports} \\`,
    `   LNA_REVIEWER='${reviewer}' \\`,
    `   AUDIOBOOK_WORKSPACE_DIR='${workspace}' \\`,
    `   LNA_DIRECTOR_URL='${resolvedEnv.LNA_DIRECTOR_URL}' \\`,
    `   LNA_QWEN_PYTHON='${resolvedEnv.LNA_QWEN_PYTHON}' \\`,
    `   LNA_QWEN_WORKER='${resolvedEnv.LNA_QWEN_WORKER}' \\`,
    `   LNA_QWEN_RUNTIME_MANIFEST='${resolvedEnv.LNA_QWEN_RUNTIME_MANIFEST}' \\`,
    `   LNA_GPU_LOCK='${resolvedEnv.LNA_GPU_LOCK}' \\`,
    '   pnpm --filter @light-novel-audiobook/web dev',
    '   ```',
    '',
    `   then open <http://127.0.0.1:3000/jobs/${jobId}> and press play on any chapter,`,
    '   or download the M4B from the same page.',
    '',
  ]
  // Versioned and never overwritten: a rerun produces a new output version and a new note.
  await writeFile(readmePath, `${lines.join('\n')}\n`, { flag: 'wx' })
  return readmePath
}

// ----------------------------------------------------------------------------------- the run

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  log(`listening-run ${SCRIPT_VERSION}`)

  const epub = path.resolve(options.epub)
  const epubStats = await pathStats(epub)
  runCheck('epub exists', epubStats?.isFile() === true, `${epub} (${epubStats?.size ?? 0} bytes)`)
  const epubSha256 = await sha256File(epub)
  log(
    `[pre-flight] ok   epub identity — ${epubStats.size} bytes, sha256 ${epubSha256} (content never opened here)`,
  )

  runCheck(
    'repository root',
    existsSync(path.join(REPOSITORY_ROOT, 'pnpm-workspace.yaml')),
    REPOSITORY_ROOT,
  )
  runCheck('node >= 24', Number(process.versions.node.split('.')[0]) >= 24, process.version)

  const { root: workspace, resumed } = await resolveSafeWorkspace({
    configured: options.workspace,
    prefix: 'lna-listening-',
    allowExistingDatabase: true,
  })
  log(`workspace: ${workspace}${resumed ? ' (existing database — this is a resume)' : ' (fresh)'}`)

  const jobId =
    options.jobId ?? `listening-${new Date().toISOString().replace(/[:.]/g, '-').replace('Z', 'Z')}`
  const reviewer =
    options.reviewer ??
    (process.env.LNA_REVIEWER?.trim().length
      ? process.env.LNA_REVIEWER
      : 'Listening run (scripted)')

  const { env: runtimeEnv, paths } = await resolveRealRuntimePaths()
  if (options.transports === 'real') {
    await checkRealRuntimePaths(paths)
    assertGpuIdle()
    assertNoModelProcesses('pre-flight')
  } else {
    log('[pre-flight] fake transports (self-test): GPU, model runtimes and ffmpeg are not needed')
  }

  const slice = {
    fromChapter: options.fromChapter,
    chapters: options.chapters,
    maxPassages: options.maxPassages,
  }
  const driverArgs = [
    'pipeline:demo',
    '--',
    '--epub',
    epub,
    '--transports',
    options.transports,
    '--workspace',
    workspace,
    '--job-id',
    jobId,
    '--from-chapter',
    String(slice.fromChapter),
    '--chapters',
    String(slice.chapters),
    '--passages',
    String(slice.maxPassages),
    '--director-url',
    paths.directorUrl,
    '--llama-runtime-root',
    paths.llamaRoot,
    '--python',
    paths.qwenPython,
    '--worker',
    paths.qwenWorker,
    '--runtime-manifest',
    paths.qwenManifest,
    '--snapshot',
    paths.snapshot,
    '--gpu-lock',
    paths.gpuLock,
  ]
  log('resolved configuration (every value the driver will run with):')
  for (const [key, value] of Object.entries(runtimeEnv)) log(`  ${key}=${value}`)
  log(`  EPUB=${epub}`)
  log(`  WORKSPACE=${workspace}`)
  log(`  JOB_ID=${jobId}`)
  log(`  REVIEWER=${reviewer}`)
  log(
    `  SLICE=from-chapter ${slice.fromChapter}, chapters ${slice.chapters}, passages <= ${slice.maxPassages} per chapter`,
  )
  log(`equivalent manual command: pnpm ${driverArgs.join(' ')}`)

  if (options.dryRun) {
    log('dry run: configuration resolved and pre-flight passed; nothing was started')
    return
  }

  const driverLog = path.join(workspace, 'driver.log')
  let driver = await runPnpmScript({
    args: driverArgs,
    env: {},
    logFile: driverLog,
  })

  const onSignal = async () => {
    driver.kill()
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  let gateApproved = false
  if (driver.exitCode !== 0 && driver.stderr.includes(REVIEW_GATE_ERROR)) {
    await walkReviewGate({ workspace, jobId, reviewer, logFile: driverLog })
    gateApproved = true
    log('[review] resuming the render from the persisted script (completed segments are reused)')
    driver = await runPnpmScript({
      args: driverArgs,
      env: {},
      logFile: driverLog,
    })
  }
  if (driver.exitCode !== 0) {
    fail(
      `the pipeline driver failed (see ${driverLog}). ` +
        `Resume a failed run with the same --workspace and --job-id; after an interrupted (killed) run, pass a fresh --job-id so the stale one is left alone.`,
    )
  }

  const report = JSON.parse(driver.stdout.trim())
  if (report.jobState !== 'completed')
    fail(`driver report jobState is ${report.jobState}, not completed`)
  const m4bStats = await pathStats(report.m4bPath)
  if (m4bStats?.isFile() !== true || m4bStats.size === 0) {
    fail(`the numbered M4B is missing or empty: ${report.m4bPath}`)
  }
  if (m4bStats.size !== report.m4bBytes) {
    fail(`M4B byte size ${m4bStats.size} disagrees with the driver report (${report.m4bBytes})`)
  }
  log(
    `[done] job completed: ${report.generatedSegments} rendered, ${report.reusedSegments} reused, ` +
      `${report.chapterOutputs.length} chapter(s), output v${report.outputVersion}`,
  )

  const probe = probeAudiobook(paths.ffprobePath, report.m4bPath, report.chapterOutputs.length)
  const readmePath = await writeListeningReadme({
    report,
    probe,
    workspace,
    jobId,
    reviewer,
    gateApproved,
    transports: options.transports,
    slice,
    resolvedEnv: runtimeEnv,
    epubSha256,
    epubBytes: epubStats.size,
  })
  log(`listening README (sanitized): ${readmePath}`)
  log(`numbered M4B: ${report.m4bPath} (${report.m4bBytes} bytes)`)
  log(
    `[done] ffprobe: ${probe.durationSeconds}s, ${probe.chapterMarkers.length} chapter marker(s), ` +
      `cover ${probe.cover === null ? 'none' : 'present'}, ${report.chapterOutputs.length} chapter file(s)`,
  )

  // Release verification: the driver owns and reaps llama-server; nothing may be left behind.
  if (options.transports === 'real') {
    assertGpuIdle()
    assertNoModelProcesses('post-run')
    if (listModelProcesses().length > 0) fail('a model process survived the run')
    log('GPU released and verified idle; no model process left behind')
  }
  log(`total elapsed: ${Math.round(elapsedMs() / 1000)}s`)
}

main().catch((error) => {
  if (error instanceof HarnessFailure) {
    console.error(`\nLISTENING RUN FAILED: ${error.message}`)
  } else {
    console.error('\nLISTENING RUN FAILED: unexpected script error:', error)
  }
  process.exitCode = 1
})
