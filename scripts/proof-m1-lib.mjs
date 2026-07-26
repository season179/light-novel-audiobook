/**
 * Shared helpers for the local proof/run scripts (proof-m1.mjs, listening-run.mjs). Everything
 * here is sanitized by contract: counts, hashes, byte sizes, paths and durations only — these
 * scripts never print story text, and neither may anything imported from here.
 *
 * Clock note: `Date.now()` runs backward on this host, so elapsed time comes from
 * `performance.now()`. Wall-clock `Date` is for names and timestamps only.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
export const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '..')

/** Pinned Gemma profile values, mirrored from packages/gemma-director/src/profile.ts. */
export const GEMMA_MODEL_FILE = 'gemma-4-26B_q4_0-it.gguf'
export const GEMMA_MODEL_BYTES = 14_439_363_584
export const EXPECTED_FFMPEG_VERSION = '7.0.2'

export const USER_DATA_ROOT = path.join(homedir(), '.local', 'share', 'light-novel-audiobook')

export class HarnessFailure extends Error {}
export const fail = (message) => {
  throw new HarnessFailure(message)
}

const startedAtMonotonic = performance.now()
export const elapsedMs = () => Math.round(performance.now() - startedAtMonotonic)
export const log = (message) => console.log(`[+${String(elapsedMs()).padStart(7)}ms] ${message}`)

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex')
export const sha256File = async (file) => sha256Hex(await readFile(file))

export const pathStats = async (candidate) => {
  try {
    return await stat(candidate)
  } catch {
    return undefined
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * One printed pre-flight line; the first failure stops the run. `detail` must itself be
 * sanitized (paths, sizes, hashes, counts — never content).
 */
export const runCheck = (name, ok, detail) => {
  log(`[pre-flight] ${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) fail(`pre-flight check failed: ${name}${detail === undefined ? '' : ` (${detail})`}`)
}

// --------------------------------------------------------------------------- workspace safety

/**
 * Scripts get their own workspace and never touch the user's real one. A workspace inside the
 * repository or inside `~/.local/share/light-novel-audiobook` is refused on canonical paths.
 * Default is a fresh mkdtemp; an explicit directory must be empty unless `allowExistingDatabase`
 * is set (a deliberate resume of a previous run's SQLite workspace).
 */
export const resolveSafeWorkspace = async ({
  configured,
  prefix,
  allowExistingDatabase = false,
}) => {
  const root =
    configured === undefined ? await mkdtemp(path.join(tmpdir(), prefix)) : path.resolve(configured)
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
        'this script never writes there',
    )
  }
  const existing = await readdir(canonical)
  if (existing.length > 0) {
    const isResume = allowExistingDatabase && existing.includes('audiobook.db')
    if (!isResume) {
      fail(
        `workspace is not fresh (${existing.length} entries, e.g. ${existing.slice(0, 3).join(', ')}); ` +
          'use an empty directory or let the script create one',
      )
    }
  }
  return { root: canonical, resumed: existing.includes('audiobook.db') }
}

// ------------------------------------------------------------------------------ network helpers

export const portIsFree = (port, host = '127.0.0.1') =>
  new Promise((resolvePromise) => {
    const socket = createConnection({ port, host })
    socket.once('connect', () => {
      socket.destroy()
      resolvePromise(false)
    })
    socket.once('error', () => resolvePromise(true))
  })

export const waitForPort = async (port, free, timeoutMs, label) => {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if ((await portIsFree(port)) === free) return
    await sleep(250)
  }
  fail(`${label}: port ${port} did not become ${free ? 'free' : 'bound'} within ${timeoutMs}ms`)
}

// ----------------------------------------------------------------------------- process helpers

export const runChecked = (command, args, label) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000 })
  if (result.error !== undefined || result.status !== 0) {
    fail(`${label} failed: ${command} ${args.join(' ')} (${result.error ?? result.stderr?.trim()})`)
  }
  return result.stdout
}

const MODEL_PROCESS_PATTERN = 'llama-server|qwen_batch_worker'

/**
 * Refuses to start a GPU run while a model process is resident. A leftover llama-server or Qwen
 * worker holding the card is exactly the leak class issue #67 exists for, so a run starts only
 * when none is alive — and after a run the same check verifies nothing was left behind.
 */
export const listModelProcesses = () => {
  const result = spawnSync('pgrep', ['-f', MODEL_PROCESS_PATTERN], {
    encoding: 'utf8',
    timeout: 15_000,
  })
  if (result.error !== undefined) {
    fail(`could not check for resident model processes: ${String(result.error)}`)
  }
  if (result.status === 1) return []
  if (result.status !== 0) fail('pgrep failed while checking for resident model processes')
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[0-9]+$/.test(line))
    .filter((pid) => Number(pid) !== process.pid)
}

export const assertNoModelProcesses = (label) => {
  const pids = listModelProcesses()
  runCheck(
    `${label}: no llama-server or Qwen worker process is resident`,
    pids.length === 0,
    pids.length === 0 ? undefined : `pid(s) ${pids.join(', ')}`,
  )
}

// ---------------------------------------------------------------------- real runtime resolution

export const dataRoot = () =>
  process.env.QWEN3_TTS_DATA_ROOT ??
  path.join(
    process.env.XDG_DATA_HOME ?? path.join(homedir(), '.local', 'share'),
    'light-novel-audiobook',
  )

/**
 * Resolves every real-runtime location exactly as the app's real mode and the pipeline driver do:
 * env overrides first, then the pinned install locations. Returns the env vars to pass on (only
 * the ones the tools read) plus the concrete paths for pre-flight checks.
 */
export const resolveRealRuntimePaths = async (env = process.env) => {
  const childEnv = {}
  const llamaRoot =
    env.LNA_LLAMA_RUNTIME_ROOT ??
    path.join(
      env.XDG_CACHE_HOME ?? path.join(homedir(), '.cache'),
      'light-novel-audiobook',
      'issue-6-brain',
    )
  childEnv.LNA_LLAMA_RUNTIME_ROOT = llamaRoot

  const uvLockPath = path.join(REPOSITORY_ROOT, 'scripts', 'qwen3-tts-runtime', 'uv.lock')
  const uvLockSha256 = await sha256File(uvLockPath)
  const runtimeDir = path.join(dataRoot(), 'runtimes', 'tts', 'qwen3-tts', uvLockSha256)
  const qwenPython = env.LNA_QWEN_PYTHON ?? path.join(runtimeDir, 'bin', 'python')
  const qwenWorker =
    env.LNA_QWEN_WORKER ??
    path.join(REPOSITORY_ROOT, 'packages', 'qwen-tts', 'python', 'qwen_batch_worker.py')
  const qwenManifest = env.LNA_QWEN_RUNTIME_MANIFEST ?? path.join(runtimeDir, 'manifest.json')
  childEnv.LNA_QWEN_PYTHON = qwenPython
  childEnv.LNA_QWEN_WORKER = qwenWorker
  childEnv.LNA_QWEN_RUNTIME_MANIFEST = qwenManifest

  const lockPath = path.join(REPOSITORY_ROOT, 'config', 'qwen3-tts-custom-voice.lock.json')
  const lock = JSON.parse(await readFile(lockPath, 'utf8'))
  const snapshot =
    env.LNA_QWEN_SNAPSHOT ??
    path.join(
      dataRoot(),
      'models',
      'tts',
      'qwen3-tts-custom-voice',
      lock.model.revision,
      'snapshot',
    )
  if (env.LNA_QWEN_SNAPSHOT !== undefined) childEnv.LNA_QWEN_SNAPSHOT = env.LNA_QWEN_SNAPSHOT

  const ffmpegDir =
    env.LIGHT_NOVEL_AUDIOBOOK_FFMPEG_DIR ?? path.join(dataRoot(), 'tools', 'ffmpeg', 'current')

  const directorUrl = env.LNA_DIRECTOR_URL ?? 'http://127.0.0.1:8080/v1'
  childEnv.LNA_DIRECTOR_URL = directorUrl

  const gpuLock = env.LNA_GPU_LOCK ?? path.join(dataRoot(), 'gpu', 'exclusive.lock')
  childEnv.LNA_GPU_LOCK = gpuLock

  return {
    env: childEnv,
    paths: {
      llamaRoot,
      llamaBinary: path.join(llamaRoot, 'llama.cpp', 'build', 'bin', 'llama-server'),
      gemmaModel: path.join(llamaRoot, 'models', GEMMA_MODEL_FILE),
      uvLockSha256,
      qwenPython,
      qwenWorker,
      qwenManifest,
      snapshot,
      ffmpegDir,
      ffmpegPath: path.join(ffmpegDir, 'ffmpeg'),
      ffprobePath: path.join(ffmpegDir, 'ffprobe'),
      directorUrl,
      directorPort: Number(new URL(directorUrl).port || 80),
      gpuLock,
    },
  }
}

/**
 * Everything createRealTransports and the FFmpeg assembler will demand, checked before anything
 * starts so a missing runtime is refused here instead of surfacing as a confusing model error
 * halfway through a render. Every line is printed.
 */
export const checkRealRuntimePaths = async (paths) => {
  runCheck(
    'llama runtime root is a directory',
    (await pathStats(paths.llamaRoot))?.isDirectory() === true,
    paths.llamaRoot,
  )
  const llamaBinaryStats = await pathStats(paths.llamaBinary)
  runCheck(
    'llama-server binary is executable',
    llamaBinaryStats !== undefined && (llamaBinaryStats.mode & 0o111) !== 0,
    paths.llamaBinary,
  )
  const gemmaStats = await pathStats(paths.gemmaModel)
  runCheck('pinned Gemma GGUF exists', gemmaStats?.isFile() === true, paths.gemmaModel)
  runCheck(
    'pinned Gemma GGUF has the pinned byte size',
    gemmaStats?.size === GEMMA_MODEL_BYTES,
    `${gemmaStats?.size ?? 0} of ${GEMMA_MODEL_BYTES} bytes`,
  )
  runCheck(
    'Qwen python exists',
    (await pathStats(paths.qwenPython))?.isFile() === true,
    paths.qwenPython,
  )
  runCheck(
    'Qwen worker script exists',
    (await pathStats(paths.qwenWorker))?.isFile() === true,
    paths.qwenWorker,
  )
  const manifestStats = await pathStats(paths.qwenManifest)
  runCheck('Qwen runtime manifest exists', manifestStats?.isFile() === true, paths.qwenManifest)
  if (manifestStats?.isFile() === true) {
    const manifest = JSON.parse(await readFile(paths.qwenManifest, 'utf8'))
    runCheck(
      'Qwen runtime manifest matches the pinned uv.lock',
      manifest.uvLockSha256 === paths.uvLockSha256,
      `uv.lock sha256 ${paths.uvLockSha256.slice(0, 16)}…`,
    )
  }
  runCheck(
    'Qwen model snapshot is a directory',
    (await pathStats(paths.snapshot))?.isDirectory() === true,
    paths.snapshot,
  )
  runCheck(
    'pinned ffmpeg exists',
    (await pathStats(paths.ffmpegPath))?.isFile() === true,
    paths.ffmpegPath,
  )
  runCheck(
    'pinned ffprobe exists',
    (await pathStats(paths.ffprobePath))?.isFile() === true,
    paths.ffprobePath,
  )
  const ffmpegVersion = runChecked(paths.ffmpegPath, ['-version'], 'ffmpeg version probe')
  runCheck(
    `ffmpeg is the pinned ${EXPECTED_FFMPEG_VERSION}`,
    ffmpegVersion.includes(`ffmpeg version ${EXPECTED_FFMPEG_VERSION}`),
    ffmpegVersion.split('\n')[0],
  )
  runCheck(
    'director port is free',
    await portIsFree(paths.directorPort),
    `127.0.0.1:${paths.directorPort}`,
  )
  runCheck(
    'GPU lock parent directory exists',
    (await pathStats(path.dirname(paths.gpuLock)))?.isDirectory() === true,
    paths.gpuLock,
  )
}

/**
 * Read-only GPU occupancy probe: refuses when any compute process holds the card, prints the
 * memory line either way.
 */
export const assertGpuIdle = () => {
  const nvidiaSmi = spawnSync(
    'nvidia-smi',
    ['--query-compute-apps=pid,used_memory', '--format=csv,noheader'],
    { encoding: 'utf8', timeout: 30_000 },
  )
  runCheck(
    'nvidia-smi is callable (read-only GPU probe)',
    nvidiaSmi.error === undefined && nvidiaSmi.status === 0,
    nvidiaSmi.error !== undefined ? String(nvidiaSmi.error) : undefined,
  )
  const holders = (nvidiaSmi.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  runCheck(
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
}
