#!/usr/bin/env node
/**
 * proof-m1 — the issue #21 proof harness. Drives the real M1 browser flow (upload EPUB, watch
 * progress, review gate, render, chapter audio, numbered M4B, forced stop, restart reuse) through
 * the same TanStack Start server-function HTTP endpoints the browser calls, against a dev server
 * this script starts and always reaps. Nothing here loads a model: `--transports fake` (the
 * default) runs against the app's built-in fakes; `--transports real` performs the GPU run and is
 * meant for the human operator.
 *
 * Usage:
 *   scripts/proof-m1.sh [--transports fake|real] [--workspace DIR] [--epub PATH]
 *                       [--port N] [--preflight-only] [--deadline-minutes N]
 *                       [--evidence PATH]
 *
 * Clock note: `Date.now()` runs backward on this host, so every elapsed-time computation below
 * uses `performance.now()`. Wall-clock `Date` is used only for timestamps in names and evidence.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  truncate,
  writeFile,
} from 'node:fs/promises'
import { createConnection } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ACCEPTANCE_M1_EPUB_PATH, buildAcceptanceM1EpubBytes } from './build-acceptance-m1-epub.mjs'
import { assertContainerProbe, ContainerCheckFailure } from './proof-m1-container-check.mjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '..')
const HARNESS_VERSION = 'proof-m1@1'

/** Pinned Gemma profile values, mirrored from packages/gemma-director/src/profile.ts. */
const GEMMA_MODEL_FILE = 'gemma-4-26B_q4_0-it.gguf'
const GEMMA_MODEL_BYTES = 14_439_363_584
const EXPECTED_FFMPEG_VERSION = '7.0.2'

/** The built-in book the app's fake extractor returns; pinned by apps/web tests. */
const FAKE_MODE_CHAPTERS = 3
/** The acceptance EPUB's chapter count (two XHTML spine documents). */
const REAL_MODE_CHAPTERS = 2

const USER_DATA_ROOT = path.join(homedir(), '.local', 'share', 'light-novel-audiobook')

class HarnessFailure extends Error {}
const fail = (message) => {
  throw new HarnessFailure(message)
}

const startedAtMonotonic = performance.now()
const elapsedMs = () => Math.round(performance.now() - startedAtMonotonic)
const log = (message) => console.log(`[+${String(elapsedMs()).padStart(7)}ms] ${message}`)

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sha256File = async (file) => sha256Hex(await readFile(file))

const pathStats = async (candidate) => {
  try {
    return await stat(candidate)
  } catch {
    return undefined
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ----------------------------------------------------------------------------- argument parsing

const parseArgs = (argv) => {
  const options = {
    transports: 'fake',
    workspace: undefined,
    epub: ACCEPTANCE_M1_EPUB_PATH,
    port: 3000,
    preflightOnly: false,
    deadlineMinutes: undefined,
    evidence: undefined,
    sabotage: undefined,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const takeValue = () => {
      const value = argv[index + 1]
      if (value === undefined) fail(`${arg} needs a value`)
      index += 1
      return value
    }
    if (arg === '--transports') options.transports = takeValue()
    else if (arg === '--workspace') options.workspace = takeValue()
    else if (arg === '--epub') options.epub = takeValue()
    else if (arg === '--port') options.port = Number(takeValue())
    else if (arg === '--preflight-only') options.preflightOnly = true
    else if (arg === '--deadline-minutes') options.deadlineMinutes = Number(takeValue())
    else if (arg === '--evidence') options.evidence = takeValue()
    else if (arg === '--sabotage') options.sabotage = takeValue()
    else if (arg === '--help' || arg === '-h') {
      console.log('scripts/proof-m1.sh [--transports fake|real] [--workspace DIR] [--epub PATH]')
      console.log('  [--port N] [--preflight-only] [--deadline-minutes N] [--evidence PATH]')
      process.exit(0)
    } else {
      fail(`unknown argument: ${arg}`)
    }
  }
  if (options.transports !== 'fake' && options.transports !== 'real') {
    fail(`--transports must be fake or real, got ${JSON.stringify(options.transports)}`)
  }
  if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65_535) {
    fail(`--port must be a TCP port number, got ${String(options.port)}`)
  }
  if (
    options.sabotage !== undefined &&
    !['truncate-segment', 'delete-m4b', 'delete-chapter-audio'].includes(options.sabotage)
  ) {
    fail(`unknown sabotage hook: ${options.sabotage}`)
  }
  return options
}

// --------------------------------------------------------------------------- workspace safety

/**
 * The harness gets its own workspace and never touches the user's real one. A workspace inside
 * the repository or inside `~/.local/share/light-novel-audiobook` is refused on canonical paths.
 */
const resolveHarnessWorkspace = async (configured, mode) => {
  const root =
    configured === undefined
      ? await mkdtemp(path.join(tmpdir(), `lna-m1-proof-${mode}-`))
      : path.resolve(configured)
  await mkdir(root, { recursive: true })
  const canonical = await realpath(root)
  const canonicalRepo = await realpath(REPOSITORY_ROOT)
  if (canonical === canonicalRepo || canonical.startsWith(`${canonicalRepo}${path.sep}`)) {
    fail(`workspace resolves inside the repository: ${canonical}`)
  }
  const userDataCanonical = await realpath(USER_DATA_ROOT).catch(() => USER_DATA_ROOT)
  if (canonical === userDataCanonical || canonical.startsWith(`${userDataCanonical}${path.sep}`)) {
    fail(
      `workspace resolves inside ${userDataCanonical}, the real user workspace; ` +
        'this harness never writes there',
    )
  }
  // A reused workspace hides failures: stale segment files, stale outputs, a stale database.
  // The proof must build its own state from scratch every run.
  const existing = await readdir(canonical)
  if (existing.length > 0) {
    fail(
      `workspace is not fresh (${existing.length} entries, e.g. ${existing.slice(0, 3).join(', ')}); ` +
        'use an empty directory or let the harness create one',
    )
  }
  return canonical
}

// ------------------------------------------------------------------------------ network helpers

const portIsFree = (port, host = '127.0.0.1') =>
  new Promise((resolvePromise) => {
    const socket = createConnection({ port, host })
    socket.once('connect', () => {
      socket.destroy()
      resolvePromise(false)
    })
    socket.once('error', () => resolvePromise(true))
  })

const waitForPort = async (port, free, timeoutMs, label) => {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if ((await portIsFree(port)) === free) return
    await sleep(250)
  }
  fail(`${label}: port ${port} did not become ${free ? 'free' : 'bound'} within ${timeoutMs}ms`)
}

const waitForHttp = async (baseUrl, server, timeoutMs, label) => {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    if (server.child.exitCode !== null) {
      fail(`${label}: dev server exited (code ${server.child.exitCode}); see ${server.logFile}`)
    }
    const up = await fetch(baseUrl, { signal: AbortSignal.timeout(2_000) })
      .then((response) => response.status < 500)
      .catch(() => false)
    if (up) return
    if (performance.now() > deadline)
      fail(`${label}: dev server did not come up within ${timeoutMs}ms`)
    await sleep(500)
  }
}

// -------------------------------------------------------------------------- seroval + transport

/**
 * Loads seroval from the pnpm store without adding a dependency edge: the server frames its
 * server-function responses with it, and speaking this protocol is the whole point of driving the
 * browser's transport rather than an in-process double.
 */
const loadSeroval = async () => {
  const storeDir = path.join(REPOSITORY_ROOT, 'node_modules', '.pnpm')
  const entries = await readdir(storeDir).catch(() => [])
  const match = entries.find((entry) => entry.startsWith('seroval@'))
  if (match === undefined) fail('seroval is not installed; run pnpm install first')
  const packageDir = path.join(storeDir, match, 'node_modules', 'seroval')
  const packageJson = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'))
  const esmEntry = packageJson.exports?.['.']?.import ?? packageJson.module
  if (typeof esmEntry !== 'string') fail('could not locate the seroval ESM entry point')
  return import(pathToFileURL(path.join(packageDir, esmEntry)).href)
}

/**
 * Discovers the server-function IDs the Vite dev server assigned, exactly as the browser bundle
 * learns them: the transformed module exports one `createClientRpc("<id>")` per function. Nothing
 * is hardcoded, so a framework bump that changes ID derivation is caught here, not misdiagnosed.
 */
const discoverServerFunctions = async (baseUrl) => {
  const response = await fetch(`${baseUrl}/src/api/audiobook-server-fns.ts`)
  if (!response.ok) {
    fail(`could not fetch the transformed server-function module: HTTP ${response.status}`)
  }
  const source = await response.text()
  const functions = new Map()
  for (const match of source.matchAll(
    /export const (\w+Fn) = createServerFn\(\{ method: "(\w+)" \}\)[\s\S]{0,200}?createClientRpc\("([^"]+)"\)/g,
  )) {
    functions.set(match[1], { method: match[2], id: match[3] })
  }
  const required = [
    'uploadEpubFn',
    'startGenerationFn',
    'getJobStateFn',
    'listChapterAudioFn',
    'listUploadsFn',
    'listFallbackReviewFn',
    'approveAllFallbacksFn',
    'renderApprovedScriptFn',
  ]
  for (const name of required) {
    if (!functions.has(name)) fail(`server-function discovery found no ${name}`)
  }
  return functions
}

/**
 * The browser's exact wire protocol: POSTs carry seroval JSON (or multipart FormData for the
 * upload), GETs carry a `payload` query parameter, every call sets `x-tsr-serverFn`, and the
 * Origin header satisfies the app's Host/Origin allowlist and CSRF middleware — the same headers
 * the browser sends from the loopback origin.
 */
const createServerFnClient = (baseUrl, seroval, functions) => {
  const unwrap = async (response, label) => {
    const text = await response.text()
    if (response.headers.get('x-tss-serialized') !== 'true') {
      fail(`${label}: expected a serialized server-function response, got HTTP ${response.status}`)
    }
    let decoded
    try {
      decoded = seroval.fromCrossJSON(JSON.parse(text), { plugins: [] })
    } catch (error) {
      fail(`${label}: could not decode the server-function response: ${String(error)}`)
    }
    if (decoded?.error != null) {
      fail(`${label}: server function returned an error: ${JSON.stringify(decoded.error)}`)
    }
    const result = decoded?.result
    if (
      result === undefined ||
      result === null ||
      typeof result !== 'object' ||
      !('ok' in result)
    ) {
      fail(`${label}: malformed WebApiResult envelope`)
    }
    if (result.ok !== true) {
      fail(`${label}: ${result.error.code} — ${result.error.message}`)
    }
    return result.value
  }

  const call = async (name, data, label) => {
    const fn = functions.get(name)
    if (fn === undefined) fail(`unknown server function ${name}`)
    const url = `${baseUrl}/_serverFn/${fn.id}`
    const headers = { 'x-tsr-serverFn': 'true', origin: baseUrl }
    if (data instanceof FormData) {
      const response = await fetch(url, { method: 'POST', headers, body: data })
      return unwrap(response, label ?? name)
    }
    const serialized = JSON.stringify(await seroval.toJSONAsync({ data }))
    if (fn.method === 'GET') {
      const response = await fetch(`${url}?payload=${encodeURIComponent(serialized)}`, { headers })
      return unwrap(response, label ?? name)
    }
    headers['content-type'] = 'application/json'
    const response = await fetch(url, { method: fn.method, headers, body: serialized })
    return unwrap(response, label ?? name)
  }

  return { call }
}

// -------------------------------------------------------------------------------- dev server

/**
 * Starts the dev server as its own process group and always reaps the group: a leaked child
 * holding a port — or worse, the GPU — is the exact failure issue #67 exists for, so cleanup
 * kills the group, never just the pnpm wrapper. Output goes to a log file in the workspace.
 */
const startDevServer = (childEnv, logFile, port) => {
  const child = spawn('pnpm', ['--filter', '@light-novel-audiobook/web', 'dev'], {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, ...childEnv },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stream = createWriteStream(logFile, { flags: 'a' })
  child.stdout.pipe(stream)
  child.stderr.pipe(stream)
  return { child, stream, logFile, port, childEnv }
}

const stopDevServer = async (server) => {
  if (server.child.exitCode === null) {
    try {
      process.kill(-server.child.pid, 'SIGTERM')
    } catch {
      return
    }
    const deadline = performance.now() + 10_000
    while (performance.now() < deadline && server.child.exitCode === null) {
      await sleep(200)
    }
    if (server.child.exitCode === null) {
      try {
        process.kill(-server.child.pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
  }
  await waitForPort(server.port, true, 15_000, 'dev server shutdown')
  server.stream.end()
}

const killDevServer = async (server) => {
  try {
    process.kill(-server.child.pid, 'SIGKILL')
  } catch {
    // already gone
  }
  await waitForPort(server.port, true, 30_000, 'forced stop')
  server.stream.end()
}

// ---------------------------------------------------------------------------------- pre-flight

const dataRoot = () =>
  process.env.QWEN3_TTS_DATA_ROOT ??
  path.join(
    process.env.XDG_DATA_HOME ?? path.join(homedir(), '.local', 'share'),
    'light-novel-audiobook',
  )

const runChecked = (command, args, label) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000 })
  if (result.error !== undefined || result.status !== 0) {
    fail(`${label} failed: ${command} ${args.join(' ')} (${result.error ?? result.stderr?.trim()})`)
  }
  return result.stdout
}

/**
 * Asserts everything a run needs before anything starts, and prints each check. Fake mode needs
 * no GPU and no models; real mode mirrors what `createRealTransports` and the FFmpeg assembler
 * will demand, so a missing runtime is refused here instead of surfacing as a confusing error
 * halfway through a render.
 */
const runPreflight = async (config) => {
  const check = (name, ok, detail) => {
    log(`[pre-flight] ${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
    if (!ok) fail(`pre-flight check failed: ${name}${detail === undefined ? '' : ` (${detail})`}`)
  }

  check(
    'repository root',
    existsSync(path.join(REPOSITORY_ROOT, 'pnpm-workspace.yaml')),
    REPOSITORY_ROOT,
  )
  check('node >= 24', Number(process.versions.node.split('.')[0]) >= 24, process.version)

  const epubStats = await pathStats(config.epub)
  check(
    'epub exists',
    epubStats?.isFile() === true,
    `${config.epub} (${epubStats?.size ?? 0} bytes)`,
  )
  if (config.epub === ACCEPTANCE_M1_EPUB_PATH) {
    const rebuilt = await buildAcceptanceM1EpubBytes()
    const committed = await readFile(ACCEPTANCE_M1_EPUB_PATH)
    check(
      'acceptance EPUB is byte-reproducible from its source tree',
      Buffer.compare(Buffer.from(rebuilt), committed) === 0,
      `sha256 ${sha256Hex(committed)}`,
    )
  }
  config.epubBytes = await readFile(config.epub)
  config.epubSha256 = sha256Hex(config.epubBytes)

  check('dev server port free', await portIsFree(config.port), `127.0.0.1:${config.port}`)
  log(`[pre-flight] ok   workspace outside repo and user data root — ${config.workspace}`)

  if (config.transports === 'fake') {
    log(
      '[pre-flight] fake transports: GPU, model runtimes and ffmpeg are not needed and not touched',
    )
    return {}
  }

  // --- real transports: everything createRealTransports and FfmpegAudioAssembler will require.
  const env = {}
  const llamaRoot =
    process.env.LNA_LLAMA_RUNTIME_ROOT ??
    path.join(
      process.env.XDG_CACHE_HOME ?? path.join(homedir(), '.cache'),
      'light-novel-audiobook',
      'issue-6-brain',
    )
  env.LNA_LLAMA_RUNTIME_ROOT = llamaRoot
  check(
    'llama runtime root is a directory',
    (await pathStats(llamaRoot))?.isDirectory() === true,
    llamaRoot,
  )
  const llamaBinary = path.join(llamaRoot, 'llama.cpp', 'build', 'bin', 'llama-server')
  const llamaBinaryStats = await pathStats(llamaBinary)
  check(
    'llama-server binary is executable',
    llamaBinaryStats !== undefined && (llamaBinaryStats.mode & 0o111) !== 0,
    llamaBinary,
  )
  const gemmaModel = path.join(llamaRoot, 'models', GEMMA_MODEL_FILE)
  const gemmaStats = await pathStats(gemmaModel)
  check('pinned Gemma GGUF exists', gemmaStats?.isFile() === true, gemmaModel)
  check(
    'pinned Gemma GGUF has the pinned byte size',
    gemmaStats?.size === GEMMA_MODEL_BYTES,
    `${gemmaStats?.size ?? 0} of ${GEMMA_MODEL_BYTES} bytes`,
  )

  const uvLockPath = path.join(REPOSITORY_ROOT, 'scripts', 'qwen3-tts-runtime', 'uv.lock')
  const uvLockSha256 = await sha256File(uvLockPath)
  const runtimeDir = path.join(dataRoot(), 'runtimes', 'tts', 'qwen3-tts', uvLockSha256)
  const qwenPython = process.env.LNA_QWEN_PYTHON ?? path.join(runtimeDir, 'bin', 'python')
  const qwenWorker =
    process.env.LNA_QWEN_WORKER ??
    path.join(REPOSITORY_ROOT, 'packages', 'qwen-tts', 'python', 'qwen_batch_worker.py')
  const qwenManifest =
    process.env.LNA_QWEN_RUNTIME_MANIFEST ?? path.join(runtimeDir, 'manifest.json')
  env.LNA_QWEN_PYTHON = qwenPython
  env.LNA_QWEN_WORKER = qwenWorker
  env.LNA_QWEN_RUNTIME_MANIFEST = qwenManifest
  check('Qwen python exists', (await pathStats(qwenPython))?.isFile() === true, qwenPython)
  check('Qwen worker script exists', (await pathStats(qwenWorker))?.isFile() === true, qwenWorker)
  const manifestStats = await pathStats(qwenManifest)
  check('Qwen runtime manifest exists', manifestStats?.isFile() === true, qwenManifest)
  if (manifestStats?.isFile() === true) {
    const manifest = JSON.parse(await readFile(qwenManifest, 'utf8'))
    check(
      'Qwen runtime manifest matches the pinned uv.lock',
      manifest.uvLockSha256 === uvLockSha256,
      `uv.lock sha256 ${uvLockSha256.slice(0, 16)}…`,
    )
  }

  const lockPath = path.join(REPOSITORY_ROOT, 'config', 'qwen3-tts-custom-voice.lock.json')
  const lock = JSON.parse(await readFile(lockPath, 'utf8'))
  const snapshot =
    process.env.LNA_QWEN_SNAPSHOT ??
    path.join(
      dataRoot(),
      'models',
      'tts',
      'qwen3-tts-custom-voice',
      lock.model.revision,
      'snapshot',
    )
  if (process.env.LNA_QWEN_SNAPSHOT !== undefined) {
    env.LNA_QWEN_SNAPSHOT = process.env.LNA_QWEN_SNAPSHOT
  }
  check(
    'Qwen model snapshot is a directory',
    (await pathStats(snapshot))?.isDirectory() === true,
    snapshot,
  )

  const ffmpegDir =
    process.env.LIGHT_NOVEL_AUDIOBOOK_FFMPEG_DIR ??
    path.join(dataRoot(), 'tools', 'ffmpeg', 'current')
  const ffmpegPath = path.join(ffmpegDir, 'ffmpeg')
  const ffprobePath = path.join(ffmpegDir, 'ffprobe')
  check('pinned ffmpeg exists', (await pathStats(ffmpegPath))?.isFile() === true, ffmpegPath)
  check('pinned ffprobe exists', (await pathStats(ffprobePath))?.isFile() === true, ffprobePath)
  const ffmpegVersion = runChecked(ffmpegPath, ['-version'], 'ffmpeg version probe')
  check(
    `ffmpeg is the pinned ${EXPECTED_FFMPEG_VERSION}`,
    ffmpegVersion.includes(`ffmpeg version ${EXPECTED_FFMPEG_VERSION}`),
    ffmpegVersion.split('\n')[0],
  )
  config.ffprobePath = ffprobePath

  const directorUrl = process.env.LNA_DIRECTOR_URL ?? 'http://127.0.0.1:8080/v1'
  env.LNA_DIRECTOR_URL = directorUrl
  const directorPort = Number(new URL(directorUrl).port || 80)
  check('director port is free', await portIsFree(directorPort), `127.0.0.1:${directorPort}`)
  config.directorPort = directorPort

  const gpuLock = process.env.LNA_GPU_LOCK ?? path.join(dataRoot(), 'gpu', 'exclusive.lock')
  env.LNA_GPU_LOCK = gpuLock
  check(
    'GPU lock parent directory exists',
    (await pathStats(path.dirname(gpuLock)))?.isDirectory() === true,
    gpuLock,
  )

  const nvidiaSmi = spawnSync(
    'nvidia-smi',
    ['--query-compute-apps=pid,used_memory', '--format=csv,noheader'],
    { encoding: 'utf8', timeout: 30_000 },
  )
  check(
    'nvidia-smi is callable (read-only GPU probe)',
    nvidiaSmi.error === undefined && nvidiaSmi.status === 0,
    nvidiaSmi.error !== undefined ? String(nvidiaSmi.error) : undefined,
  )
  const holders = (nvidiaSmi.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  check(
    'GPU is idle: no compute process holds the card',
    holders.length === 0,
    holders.length === 0
      ? undefined
      : `held by pid(s) ${holders.map((line) => line.split(',')[0]).join(', ')}`,
  )
  const memory = spawnSync(
    'nvidia-smi',
    ['--query-gpu=memory.used,memory.total', '--format=csv,noheader'],
    { encoding: 'utf8', timeout: 30_000 },
  )
  if (memory.status === 0) log(`[pre-flight] GPU memory: ${memory.stdout.trim()}`)

  if (process.env.LNA_REVIEWER === undefined || process.env.LNA_REVIEWER.trim().length === 0) {
    log(
      '[pre-flight] LNA_REVIEWER unset; the review decision will be recorded as "M1 Proof Harness"',
    )
  }
  return env
}

// ------------------------------------------------------------------------------ poll helper

const pollJobUntil = async (client, jobId, predicate, options) => {
  const { timeoutMs, label, onTick, expectFailed = false } = options
  const deadline = performance.now() + timeoutMs
  let lastPrinted = ''
  let lastHeartbeat = performance.now()
  for (;;) {
    const view = await client.call('getJobStateFn', { jobId })
    if (view === null) fail(`${label}: job ${jobId} does not exist`)
    const line =
      `${view.state}/${view.stage} segments ${view.completedSegments}/${view.totalSegments}` +
      `${view.percentComplete === null ? '' : ` (${view.percentComplete}%)`} — ${view.latestMessage}`
    if (line !== lastPrinted || performance.now() - lastHeartbeat > 30_000) {
      log(`[poll] ${line}`)
      lastPrinted = line
      lastHeartbeat = performance.now()
    }
    if (onTick !== undefined) await onTick(view)
    const outcome = predicate(view)
    if (outcome !== undefined) return outcome
    if (view.state === 'failed' && !expectFailed) fail(`${label}: job failed — ${view.error}`)
    if (performance.now() > deadline) {
      fail(`${label}: timed out after ${Math.round(timeoutMs / 1000)}s`)
    }
    await sleep(1_000)
  }
}

/** Segment IDs are content-free (`book-<hash>-chNNNN-pNNNNNN-sNNNN`), so they are safe to count. */
const chapterOfSegment = (segmentId) => /-ch(\d{4})-/.exec(segmentId)?.[1]
const passageOfSegment = (segmentId) => /-ch\d{4}-p\d{6}-/.exec(segmentId)?.[0]

const listFilesRecursive = async (directory, suffix) => {
  const found = []
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name.endsWith(suffix)) found.push(full)
    }
  }
  await walk(directory)
  return found.sort()
}

// ------------------------------------------------------------------ step 6: forced stop (fake)

/**
 * Fake mode: the dev server's fakes are deliberately in-memory, so killing it would lose the job
 * rather than prove reuse. The forced stop is therefore a deterministic mid-render fault injected
 * through the workspace the harness owns — a directory where the speech engine must write a
 * segment WAV — after which the same HTTP surface retries the failed job. Reuse is then asserted
 * on the filesystem: a re-rendered segment is a rewritten file, a reused one is byte- and
 * mtime-identical.
 *
 * Returns the blocked segment path so the fault can be armed before the render starts; the fake
 * render is far too fast to interrupt after the fact.
 */
const armFakeForcedStop = async (config, client, jobId, reviewItems) => {
  const segmentsDir = path.join(config.workspace, 'segments')
  let blocked = [...reviewItems].sort((left, right) =>
    (chapterOfSegment(right) ?? '').localeCompare(chapterOfSegment(left) ?? ''),
  )[0]
  if (blocked === undefined) {
    const view = await client.call('getJobStateFn', { jobId })
    if (view.bookId === null) fail('forced stop: the job has no book to derive a segment from')
    blocked = `${view.bookId}-ch${String(config.expectedChapters ?? 1).padStart(4, '0')}-p000001-s0001`
  }
  const blockedPath = path.join(segmentsDir, `${blocked}.wav`)
  await mkdir(blockedPath, { recursive: true })
  log(`[step 6] armed a mid-render fault at ${blocked} (a directory where a WAV must be written)`)
  return { blocked, blockedPath, segmentsDir }
}

const fakeForcedStop = async (config, client, jobId, armed, remainingMs) => {
  const stopped = await pollJobUntil(
    client,
    jobId,
    (view) => (view.state === 'failed' ? view : undefined),
    {
      timeoutMs: remainingMs(),
      label: 'blocked render',
      expectFailed: true,
    },
  )

  const before = new Map()
  for (const entry of await readdir(armed.segmentsDir)) {
    const full = path.join(armed.segmentsDir, entry)
    const stats = await stat(full)
    if (stats.isFile()) {
      before.set(entry, { sha256: await sha256File(full), mtimeMs: stats.mtimeMs })
    }
  }
  if (before.size === 0) {
    fail('forced stop: no segment completed before the stop; there is nothing to reuse')
  }
  if (before.size >= stopped.totalSegments) {
    fail('forced stop: every segment completed before the stop; not a mid-render stop')
  }
  log(
    `[step 6] render stopped at ${before.size}/${stopped.totalSegments} segments ` +
      `(job state: ${stopped.state})`,
  )

  if (config.sabotage === 'truncate-segment') {
    const victim = [...before.keys()][0]
    await truncate(path.join(armed.segmentsDir, victim), 8)
    log(`[step 6] sabotage: truncated ${victim} to 8 bytes — the reuse assertion must now fail`)
  }

  // Restart the render over the same HTTP surface. The failed job retries from its persisted
  // script: no re-extraction, no re-direction, and completed segments come back from the reuse
  // ledger instead of being re-rendered.
  await rm(armed.blockedPath, { recursive: true })
  const uploads = await client.call('listUploadsFn', {})
  const upload = uploads.find((candidate) => candidate.jobId === jobId)
  if (upload === undefined) fail('restart: the upload for this job is gone from the workspace')
  await client.call('startGenerationFn', { uploadId: upload.uploadId }, '6-restart')
  log('[step 6] restarted the failed job over HTTP; polling to completion')
  const finalView = await pollJobUntil(
    client,
    jobId,
    (view) => (view.state === 'completed' ? view : undefined),
    {
      timeoutMs: remainingMs(),
      label: 'restarted run',
    },
  )

  let reused = 0
  const rerendered = []
  for (const [name, previous] of before) {
    const full = path.join(armed.segmentsDir, name)
    const stats = await stat(full)
    const now = { sha256: await sha256File(full), mtimeMs: stats.mtimeMs }
    if (now.sha256 === previous.sha256 && now.mtimeMs === previous.mtimeMs) reused += 1
    else rerendered.push(name)
  }
  const after = (await readdir(armed.segmentsDir)).filter((entry) => entry.endsWith('.wav'))
  const renderedAfterRestart = after.length - reused
  if (rerendered.length > 0) {
    fail(
      `restart reuse: ${rerendered.length} segment(s) that completed before the stop were ` +
        `re-rendered instead of reused (${rerendered.slice(0, 3).join(', ')})`,
    )
  }
  if (renderedAfterRestart !== stopped.totalSegments - before.size) {
    fail(
      `restart reuse: expected ${stopped.totalSegments - before.size} new segment(s) after the ` +
        `restart, found ${renderedAfterRestart}`,
    )
  }
  if (finalView.completedSegments !== finalView.totalSegments) {
    fail('restart: job completed but its progress disagrees')
  }
  log(
    `[step 6] reuse proven: ${reused} segment(s) reused untouched, ` +
      `${renderedAfterRestart} rendered after the restart`,
  )
  return {
    mechanism:
      'deterministic mid-render fault (a directory blocking one segment WAV), then an HTTP retry of the failed job',
    stateAtStop: stopped.state,
    segmentsCompletedAtStop: before.size,
    totalSegments: stopped.totalSegments,
    segmentsReused: reused,
    segmentsRenderedAfterRestart: renderedAfterRestart,
    directorRequestsAfterRestart: null,
    directorRequestsNote:
      'not observable in fake mode: the in-process fake director has no HTTP endpoint. The resume ' +
      'path constructs no director when the persisted script is fully approved; the real-mode run ' +
      'asserts exactly that through the director port.',
  }
}

// ------------------------------------------------------------------ step 6: forced stop (real)

/**
 * Real mode: the dev server is SIGKILLed mid-render — the genuine crash — and restarted against
 * the same workspace; the job is recovered over HTTP with recoverAbandoned, and reuse is asserted
 * from the workspace SQLite database.
 */
const realForcedStop = async (config, serverRef, clientRef, jobId, baseUrl, remainingMs) => {
  const killView = await pollJobUntil(
    clientRef.current,
    jobId,
    (view) => {
      if (
        view.stage === 'rendering' &&
        view.completedSegments >= 1 &&
        view.completedSegments < view.totalSegments
      ) {
        return view
      }
      return undefined
    },
    { timeoutMs: remainingMs(), label: 'render watch before the forced stop' },
  )
  log(
    `[step 6] rendering at ${killView.completedSegments}/${killView.totalSegments}; ` +
      'sending SIGKILL to the dev server process group',
  )
  await killDevServer(serverRef.current)

  const { DatabaseSync } = await import('node:sqlite')
  const dbPath = path.join(config.workspace, 'audiobook.db')
  if (!(await pathStats(dbPath))?.isFile()) {
    fail(`workspace database missing after the kill: ${dbPath}`)
  }
  const readArtifacts = (db) =>
    db
      .prepare(
        'SELECT segment_id, sha256, byte_length, created_at FROM artifacts ORDER BY segment_id',
      )
      .all()
      .map((row) => ({
        segmentId: row.segment_id,
        sha256: row.sha256,
        byteLength: row.byte_length,
        createdAt: row.created_at,
      }))
  // Story text never leaves the workspace: only the digest of the full script is recorded.
  const scriptDigest = (db) => {
    const rows = db
      .prepare('SELECT id, source_text, kind, speaker_id, confidence FROM segments ORDER BY id')
      .all()
    return sha256Hex(Buffer.from(JSON.stringify(rows)))
  }

  const db = new DatabaseSync(dbPath)
  const snapshotRow = db.prepare('SELECT snapshot_json FROM jobs WHERE id = ?').get(jobId)
  const snapshotAtKill =
    snapshotRow === undefined ? undefined : JSON.parse(snapshotRow.snapshot_json)
  if (snapshotAtKill?.state !== 'running') {
    db.close()
    fail(
      `forced stop: expected a stale 'running' job in the workspace database, found ` +
        `${String(snapshotAtKill?.state)} — the render may have finished before the kill landed`,
    )
  }
  const artifactsAtKill = readArtifacts(db)
  const scriptAtKill = scriptDigest(db)
  db.close()
  if (artifactsAtKill.length === 0) {
    fail('forced stop: no completed segment artifacts at kill time')
  }
  log(
    `[step 6] database at kill: state=running, ${artifactsAtKill.length} completed segment artifact(s)`,
  )

  log('[step 6] restarting the dev server against the same workspace')
  serverRef.current = startDevServer(
    serverRef.current.childEnv,
    serverRef.current.logFile,
    config.port,
  )
  await waitForHttp(baseUrl, serverRef.current, 120_000, 'server restart')
  const restarted = createServerFnClient(
    baseUrl,
    await loadSeroval(),
    await discoverServerFunctions(baseUrl),
  )
  clientRef.current = restarted
  const uploads = await restarted.call('listUploadsFn', {})
  const upload = uploads.find((candidate) => candidate.jobId === jobId)
  if (upload === undefined) fail('restart: upload missing from the workspace after the kill')
  await restarted.call(
    'startGenerationFn',
    { uploadId: upload.uploadId, recoverAbandoned: true },
    '6-recover',
  )
  log('[step 6] recovery started with recoverAbandoned; the director port must stay unbound')

  let directorBinds = 0
  const finalView = await pollJobUntil(
    restarted,
    jobId,
    (view) => (view.state === 'completed' ? view : undefined),
    {
      timeoutMs: remainingMs(),
      label: 'recovered run',
      onTick: async () => {
        if (!(await portIsFree(config.directorPort))) directorBinds += 1
      },
    },
  )
  if (directorBinds > 0) {
    fail(
      `restart reuse: the director port was bound ${directorBinds} time(s) after the restart; ` +
        'a fully approved script must resume without constructing the director',
    )
  }

  const dbAfter = new DatabaseSync(dbPath)
  const artifactsAfter = readArtifacts(dbAfter)
  const scriptAfter = scriptDigest(dbAfter)
  dbAfter.close()
  if (scriptAfter !== scriptAtKill) {
    fail(
      'restart reuse: the persisted script changed across the restart — the book was re-directed',
    )
  }
  const afterById = new Map(artifactsAfter.map((row) => [row.segmentId, row]))
  let reused = 0
  const disturbed = []
  for (const row of artifactsAtKill) {
    const now = afterById.get(row.segmentId)
    if (
      now !== undefined &&
      now.sha256 === row.sha256 &&
      now.byteLength === row.byteLength &&
      now.createdAt === row.createdAt
    ) {
      reused += 1
    } else {
      disturbed.push(row.segmentId)
    }
  }
  if (disturbed.length > 0) {
    fail(
      `restart reuse: ${disturbed.length} artifact row(s) changed across the restart ` +
        `(${disturbed.slice(0, 3).join(', ')}) — those segments were re-rendered`,
    )
  }
  const renderedAfterRestart = artifactsAfter.length - reused
  if (renderedAfterRestart !== finalView.totalSegments - artifactsAtKill.length) {
    fail(
      `restart reuse: expected ${finalView.totalSegments - artifactsAtKill.length} new artifact(s), ` +
        `the database shows ${renderedAfterRestart}`,
    )
  }
  log(
    `[step 6] reuse proven from the workspace database: ${reused} reused, ` +
      `${renderedAfterRestart} rendered after restart, 0 director requests`,
  )
  return {
    mechanism:
      'SIGKILL to the dev server process group mid-render, then an HTTP recoverAbandoned restart',
    stateAtStop: 'running',
    segmentsCompletedAtStop: artifactsAtKill.length,
    totalSegments: finalView.totalSegments,
    segmentsReused: reused,
    segmentsRenderedAfterRestart: renderedAfterRestart,
    directorRequestsAfterRestart: 0,
    scriptUnchangedAcrossRestart: true,
  }
}

// ------------------------------------------------------------------ step 5: verify output

const verifyOutput = async (config, client, jobId, baseUrl) => {
  log('[step 5] verifying the audiobook output')

  if (config.sabotage === 'delete-m4b' || config.sabotage === 'delete-chapter-audio') {
    const suffix = config.sabotage === 'delete-m4b' ? '.m4b' : '.wav'
    const candidates = (await listFilesRecursive(config.workspace, suffix)).filter(
      (file) => !file.includes(`${path.sep}segments${path.sep}`),
    )
    const victim = candidates[0]
    if (victim !== undefined) {
      await rm(victim)
      log(`[step 5] sabotage: deleted ${path.basename(victim)} — verification must now fail`)
    }
  }

  const listing = await client.call('listChapterAudioFn', { jobId })
  if (!listing.ready) fail('verification: chapter audio listing is not ready')
  if (
    config.expectedChapters !== undefined &&
    listing.chapters.length !== config.expectedChapters
  ) {
    fail(
      `verification: expected ${config.expectedChapters} chapter(s) of audio, ` +
        `the listing has ${listing.chapters.length}`,
    )
  }
  if (listing.chapters.length === 0) fail('verification: the chapter audio list is empty')

  const chapters = []
  for (const chapter of listing.chapters) {
    const response = await fetch(`${baseUrl}${chapter.audioUrl}`, { headers: { origin: baseUrl } })
    if (!response.ok) {
      fail(`verification: chapter audio ${chapter.chapterId} answered HTTP ${response.status}`)
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength === 0) fail(`verification: chapter audio ${chapter.chapterId} is empty`)
    const expectedMagic = config.transports === 'fake' ? 'RIFF' : 'fLaC'
    if (bytes.subarray(0, 4).toString('latin1') !== expectedMagic) {
      fail(`verification: chapter audio ${chapter.chapterId} is not a ${expectedMagic} file`)
    }
    chapters.push({
      chapterId: chapter.chapterId,
      bytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
    })
    log(`[step 5] chapter audio ${chapter.chapterLabel}: ${bytes.byteLength} bytes, readable`)
  }

  if (listing.download === null) fail('verification: no download link for the assembled audiobook')
  const download = await fetch(`${baseUrl}${listing.download.url}`, {
    headers: { origin: baseUrl },
  })
  if (!download.ok) fail(`verification: audiobook download answered HTTP ${download.status}`)
  const m4b = Buffer.from(await download.arrayBuffer())
  if (m4b.byteLength === 0) fail('verification: the downloaded M4B is empty')
  const container = await inspectContainer(config, m4b, listing.chapters.length)

  const m4bFiles = await listFilesRecursive(config.workspace, '.m4b')
  if (m4bFiles.length !== 1) {
    fail(
      `verification: expected exactly one numbered M4B in the workspace, found ${m4bFiles.length}`,
    )
  }
  if (path.basename(m4bFiles[0]) !== listing.download.fileName) {
    fail(
      `verification: workspace M4B ${path.basename(m4bFiles[0])} disagrees with the download ` +
        `name ${listing.download.fileName}`,
    )
  }
  log(`[step 5] numbered M4B: ${m4bFiles[0]} (${m4b.byteLength} bytes)`)

  return {
    chapterCount: chapters.length,
    chapters,
    m4b: {
      fileName: listing.download.fileName,
      bytes: m4b.byteLength,
      sha256: sha256Hex(m4b),
      workspacePath: m4bFiles[0],
    },
    container,
  }
}

/**
 * Real mode inspects the M4B container with the pinned ffprobe — AAC stream, one marker per
 * chapter, ordered non-overlapping spans within the encoded duration, and for the acceptance
 * book the embedded cover (attached-picture stream) and title/creator metadata the epic names —
 * mirroring what FfmpegAudioAssembler.assertAudiobook verifies at assembly time. The assertions
 * live in proof-m1-container-check.mjs so they can be driven with broken probe output directly.
 *
 * Fake mode's assembler concatenates placeholder WAVs into a RIFF payload under the `.m4b` name
 * (a documented shortcut, see FakeAudioAssembler), so the honest check there is the RIFF/WAVE
 * structure, and MP4 container inspection is reported as not applicable.
 */
const inspectContainer = async (config, m4b, expectedChapters) => {
  if (config.transports === 'fake') {
    if (
      m4b.subarray(0, 4).toString('latin1') !== 'RIFF' ||
      m4b.subarray(8, 12).toString('latin1') !== 'WAVE'
    ) {
      fail('verification: the fake M4B is not the documented RIFF/WAVE payload')
    }
    return {
      kind: 'riff-wave-in-m4b',
      note: 'fake assembler shortcut; MP4 chapter-marker inspection applies to real mode only',
    }
  }
  const scratch = path.join(config.workspace, 'proof-m4b-probe.m4b')
  await writeFile(scratch, m4b)
  try {
    const raw = runChecked(
      config.ffprobePath,
      ['-v', 'error', '-show_format', '-show_streams', '-show_chapters', '-of', 'json', scratch],
      'ffprobe container inspection',
    )
    const probe = JSON.parse(raw)
    let container
    try {
      container = assertContainerProbe(probe, {
        expectedChapters,
        // The acceptance book declares a cover and a creator, so its M4B must embed both;
        // a custom book without them writes neither by design.
        expectCover: config.epub === ACCEPTANCE_M1_EPUB_PATH,
        expectCreator: config.epub === ACCEPTANCE_M1_EPUB_PATH,
      })
    } catch (error) {
      if (error instanceof ContainerCheckFailure) fail(`verification: ${error.message}`)
      throw error
    }
    return {
      kind: 'mp4',
      ...container,
    }
  } finally {
    await rm(scratch, { force: true })
  }
}

// ------------------------------------------------------------------ step 7: write evidence

/** Distinct source passages behind the rendered segments, derived from content-free segment IDs. */
const countPassages = async (config) => {
  let segmentIds
  if (config.transports === 'fake') {
    segmentIds = await readdir(path.join(config.workspace, 'segments')).catch(() => [])
  } else {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(path.join(config.workspace, 'audiobook.db'), { readOnly: true })
    try {
      segmentIds = db
        .prepare('SELECT segment_id FROM artifacts')
        .all()
        .map((row) => row.segment_id)
    } finally {
      db.close()
    }
  }
  return new Set(
    segmentIds.map((name) => passageOfSegment(name)).filter((passage) => passage !== undefined),
  ).size
}

/** Versioned evidence: the canonical name is used when free, never overwritten otherwise. */
const writeEvidence = async (configured, mode, evidence) => {
  const canonical =
    configured === undefined
      ? path.join(REPOSITORY_ROOT, 'docs', 'evidence', `issue-21-m1-proof-${mode}.json`)
      : path.resolve(configured)
  await mkdir(path.dirname(canonical), { recursive: true })
  let target = canonical
  if (existsSync(target)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    target = canonical.replace(/\.json$/, `-${stamp}.json`)
  }
  await writeFile(target, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' })
  return target
}

// ----------------------------------------------------------------------------------- the run

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  const mode = options.transports
  const deadlineMs = (options.deadlineMinutes ?? (mode === 'fake' ? 30 : 12 * 60)) * 60 * 1000
  const runDeadline = performance.now() + deadlineMs
  const remainingMs = () => {
    const remaining = runDeadline - performance.now()
    if (remaining <= 0) {
      fail(`overall deadline of ${Math.round(deadlineMs / 60_000)} minutes hit`)
    }
    return remaining
  }

  log(`proof-m1 ${HARNESS_VERSION} — transports=${mode}`)
  const config = {
    transports: mode,
    epub: path.resolve(options.epub),
    port: options.port,
    workspace: await resolveHarnessWorkspace(options.workspace, mode),
    expectedChapters:
      mode === 'fake'
        ? FAKE_MODE_CHAPTERS
        : options.epub === ACCEPTANCE_M1_EPUB_PATH
          ? REAL_MODE_CHAPTERS
          : undefined,
    sabotage: options.sabotage,
  }
  log(`workspace: ${config.workspace}`)

  // ------------------------------------------------------------------ step 1: pre-flight
  log('[step 1] pre-flight checks')
  const realEnv = await runPreflight(config)
  if (options.preflightOnly) {
    log('pre-flight passed; --preflight-only stops here (nothing was started)')
    return
  }

  const baseUrl = `http://127.0.0.1:${config.port}`
  const childEnv = {
    LNA_WEB_TRANSPORTS: mode,
    AUDIOBOOK_WORKSPACE_DIR: config.workspace,
    LNA_REVIEWER: process.env.LNA_REVIEWER ?? 'M1 Proof Harness',
    ...realEnv,
  }
  if (mode === 'real') {
    log('real-mode server environment (every variable spelled out):')
    const shown = Object.entries(childEnv).filter(
      ([key]) => key.startsWith('LNA_') || key === 'AUDIOBOOK_WORKSPACE_DIR',
    )
    for (const [key, value] of shown) log(`  ${key}=${value}`)
    log(
      'equivalent manual command: ' +
        shown.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ') +
        ' pnpm --filter @light-novel-audiobook/web dev',
    )
  }

  const serverLog = path.join(config.workspace, 'dev-server.log')
  const serverRef = { current: startDevServer(childEnv, serverLog, config.port) }
  const clientRef = { current: undefined }
  const cleanup = async () => {
    await stopDevServer(serverRef.current).catch(() => undefined)
  }
  process.on('SIGINT', async () => {
    await cleanup()
    process.exit(130)
  })
  process.on('SIGTERM', async () => {
    await cleanup()
    process.exit(143)
  })

  const evidence = {
    schema: 'issue-21-m1-proof@1',
    harness: HARNESS_VERSION,
    mode,
    startedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      transports: mode,
      adapters:
        mode === 'fake'
          ? 'app fakes (fake-director/1, fake-speech-engine/2, fake-assembler/2); no model, no ffmpeg'
          : 'real adapters (#28 EPUB, #30 Gemma, #31 Qwen, #32 FFmpeg, #27 SQLite)',
    },
    epub: {
      fileName: path.basename(config.epub),
      bytes: config.epubBytes.byteLength,
      sha256: config.epubSha256,
    },
    steps: [],
  }
  const recordStep = (name, detail) => {
    evidence.steps.push({ name, atMonotonicMs: elapsedMs(), ...detail })
  }
  recordStep('1-preflight', { mode })

  try {
    log(`waiting for the dev server on ${baseUrl} (log: ${serverLog})`)
    await waitForHttp(baseUrl, serverRef.current, 120_000, 'server start')
    log('dev server is up')

    const seroval = await loadSeroval()
    const functions = await discoverServerFunctions(baseUrl)
    log(`server functions discovered over HTTP: ${[...functions.keys()].length}`)
    clientRef.current = createServerFnClient(baseUrl, seroval, functions)
    const client = clientRef.current
    if (mode === 'real') {
      log(
        'note: the first server call composes the real adapters (Python worker); it can take minutes',
      )
    }

    // ---------------------------------------------------------------- step 2: upload + start
    const form = new FormData()
    form.set('file', new Blob([config.epubBytes]), path.basename(config.epub))
    const upload = await client.call('uploadEpubFn', form, '2-upload')
    evidence.job = { jobId: upload.jobId, uploadId: upload.uploadId }
    recordStep('2-upload', { byteLength: upload.byteLength })
    log(`[step 2] uploaded ${upload.byteLength} bytes; job ${upload.jobId}`)

    // Idempotency: a workspace that already holds this EPUB's job must not silently continue the
    // old run — that is exactly the failure-hiding reuse the brief forbids.
    const prior = await client.call('getJobStateFn', { jobId: upload.jobId })
    if (prior !== null) {
      fail(
        `workspace already holds job ${upload.jobId} (state ${prior.state}); ` +
          'use a fresh workspace so the run proves itself from scratch',
      )
    }
    await client.call('startGenerationFn', { uploadId: upload.uploadId }, '2-start')
    recordStep('2-start', {})
    log('[step 2] generation started')

    // ---------------------------------------------------------------- step 3: poll progress
    const initial = await pollJobUntil(
      client,
      upload.jobId,
      (view) => {
        if (view.state === 'awaiting_review' || view.state === 'completed') return view
        return undefined
      },
      { timeoutMs: remainingMs(), label: 'initial run' },
    )
    recordStep('3-poll', { state: initial.state })
    log(`[step 3] initial run reached: ${initial.state}`)

    // ------------------------------------------------------- step 4: walk the review gate
    let reviewItems = []
    if (initial.state === 'awaiting_review') {
      const review = await client.call('listFallbackReviewFn', { jobId: upload.jobId })
      // review.items carry story-text excerpts for the human reader; they are never logged here.
      reviewItems = review.items.map((item) => item.segmentId)
      log(
        `[step 4] review queue: ${review.pendingCount} pending decision(s), ` +
          `grant: ${review.grantedBy === null ? 'none' : 'present'}`,
      )
      const decided = await client.call('approveAllFallbacksFn', { jobId: upload.jobId })
      if (decided.pendingCount !== 0) {
        fail(
          `review gate: ${decided.pendingCount} decision(s) still pending after the book-wide approval`,
        )
      }
      recordStep('4-review', {
        pendingBefore: review.pendingCount,
        pendingAfter: decided.pendingCount,
        itemCount: review.items.length,
      })
      log(`[step 4] book-wide approval recorded for ${review.items.length} segment(s)`)
    } else {
      recordStep('4-review', { pendingBefore: 0, pendingAfter: 0, itemCount: 0 })
      log('[step 4] no unresolved speakers; the review gate was not needed')
    }

    // ------------------------------------------- step 6: forced stop, restart, reuse
    // In fake mode the fault is armed before the render starts (the fake render is far too fast
    // to interrupt); in real mode the kill lands once rendering is verifiably under way. A book
    // that needed no review is already complete here and cannot prove a mid-render stop.
    if (initial.state === 'completed') {
      fail(
        'the run completed without a review stop, so a mid-render forced stop cannot be ' +
          'proven on this book; the acceptance EPUB always stops for review',
      )
    }
    let armed = null
    if (mode === 'fake') {
      armed = await armFakeForcedStop(config, client, upload.jobId, reviewItems)
    }
    await client.call('renderApprovedScriptFn', { jobId: upload.jobId })
    log('[step 4] render resumed from the persisted script')
    evidence.restart =
      mode === 'fake'
        ? await fakeForcedStop(config, client, upload.jobId, armed, remainingMs)
        : await realForcedStop(config, serverRef, clientRef, upload.jobId, baseUrl, remainingMs)
    recordStep('6-restart', { ...evidence.restart })

    // ------------------------------------------------------------- step 5: verify output
    evidence.output = await verifyOutput(config, clientRef.current, upload.jobId, baseUrl)
    recordStep('5-verify', {
      chapterCount: evidence.output.chapterCount,
      m4bBytes: evidence.output.m4b.bytes,
    })

    // ------------------------------------------------------------- step 7: write evidence
    evidence.counts = {
      chapters: evidence.output.chapterCount,
      segments: evidence.restart.totalSegments,
      passages: await countPassages(config),
    }
    evidence.finishedAt = new Date().toISOString()
    evidence.durationsMs = { total: elapsedMs() }
    recordStep('7-evidence', {})
    const evidencePath = await writeEvidence(options.evidence, mode, evidence)
    log(`[step 7] evidence written: ${evidencePath}`)
    log(`workspace (uploads, segment audio, outputs) kept at: ${config.workspace}`)
    log('PROOF GREEN: all seven steps completed')
  } finally {
    await cleanup()
  }
}

main().catch((error) => {
  if (error instanceof HarnessFailure) {
    console.error(`\nPROOF RED: ${error.message}`)
  } else {
    console.error('\nPROOF RED: unexpected harness error:', error)
  }
  process.exitCode = 1
})
