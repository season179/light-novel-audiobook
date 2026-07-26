#!/usr/bin/env node
/**
 * One-passage real M1 run with content-free Gemma/Qwen process, request, and kernel-flock evidence.
 * Request bodies and response bodies are never read here: the director emits only IDs, hashes,
 * counts, status, and monotonic timing to a private JSONL receipt file.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { ACCEPTANCE_M1_EPUB_PATH } from './build-acceptance-m1-epub.mjs'
import {
  assertGpuIdle,
  checkRealRuntimePaths,
  fail,
  GEMMA_MODEL_BYTES,
  portIsFree,
  resolveRealRuntimePaths,
  resolveSafeWorkspace,
  sleep,
} from './proof-m1-lib.mjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '..')
const SELECTED_MODEL_ID = 'google-gemma-4-26b-a4b-it-qat-q4-0'
const SAMPLE_INTERVAL_MS = 75
const RUN_DEADLINE_MS = 20 * 60_000
const EXPECTED_IDLE_MEMORY_MIB = 379

const monotonicNs = () => process.hrtime.bigint()
const nsString = () => monotonicNs().toString()

const parseArgs = (argv) => {
  const options = {
    evidence: path.join(REPOSITORY_ROOT, 'docs/evidence/issue-21-gemma-provenance-real.json'),
    workspace: undefined,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined) fail(`${argument} needs a value`)
      index += 1
      return next
    }
    if (argument === '--evidence') options.evidence = path.resolve(value())
    else if (argument === '--workspace') options.workspace = path.resolve(value())
    else fail(`unknown argument: ${argument}`)
  }
  return options
}

const runChecked = (command, args, label) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15_000 })
  if (result.error !== undefined || result.status !== 0) {
    fail(`${label} failed (${result.error ?? result.status})`)
  }
  return result.stdout
}

const processAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const parseProcStartTime = (raw) => {
  const close = raw.lastIndexOf(')')
  const fields =
    close === -1
      ? []
      : raw
          .slice(close + 2)
          .trim()
          .split(/\s+/u)
  const startTime = fields[19]
  if (startTime === undefined || !/^\d+$/u.test(startTime)) {
    fail('could not parse llama-server process start time')
  }
  return startTime
}

const processRows = () =>
  runChecked('ps', ['-eo', 'pid=,comm=,args='], 'process observation')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+)\s+(\S+)\s+(.*)$/u.exec(line)
      return match === null
        ? undefined
        : { pid: Number(match[1]), command: match[2], arguments: match[3] }
    })
    .filter((row) => row !== undefined)

const processSnapshot = () => {
  const rows = processRows()
  return {
    llamaPids: rows.filter((row) => row.command === 'llama-server').map((row) => row.pid),
    qwenWorkerPids: rows
      .filter(
        (row) => /^python/u.test(row.command) && row.arguments.includes('/qwen_batch_worker.py'),
      )
      .map((row) => row.pid),
  }
}

const leaseOwner = (pid) => {
  try {
    const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
    if (args.some((argument) => argument.startsWith('gemma-'))) return 'gemma'
    if (args.some((argument) => argument.startsWith('qwen3-tts-'))) return 'qwen3-tts'
  } catch {
    // The holder may exit between lslocks and /proc; the next 75 ms sample resolves it.
  }
  return 'unknown'
}

const kernelLockSnapshot = (lockPath) => {
  const parsed = JSON.parse(
    runChecked(
      'lslocks',
      ['--json', '--notruncate', '--output', 'PID,TYPE,MODE,PATH'],
      'kernel flock observation',
    ),
  )
  return parsed.locks
    .filter((lock) => lock.type === 'FLOCK' && path.resolve(lock.path) === lockPath)
    .map((lock) => ({
      holderPid: Number(lock.pid),
      mode: lock.mode,
      owner: leaseOwner(Number(lock.pid)),
    }))
}

const gpuSnapshot = () => {
  const line = runChecked(
    'nvidia-smi',
    ['--query-gpu=memory.used,memory.total,utilization.gpu', '--format=csv,noheader,nounits'],
    'GPU snapshot',
  )
    .trim()
    .split(',')
    .map((part) => Number(part.trim()))
  if (line.length !== 3 || line.some((value) => !Number.isFinite(value))) {
    fail('GPU snapshot was malformed')
  }
  return { memoryUsedMiB: line[0], memoryTotalMiB: line[1], utilizationPercent: line[2] }
}

const argumentAfter = (args, flag) => {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

const listenerOwnedBy = (port, pid) => {
  const output = runChecked('ss', ['-ltnp', `sport = :${port}`], 'director listener observation')
  return output.includes(`pid=${pid},`)
}

class RuntimeMonitor {
  constructor({ lockPath, directorOrigin, expectedBinary, expectedModelPath }) {
    this.lockPath = path.resolve(lockPath)
    this.directorOrigin = directorOrigin
    this.directorPort = Number(new URL(directorOrigin).port || 80)
    this.expectedBinary = realpathSync(expectedBinary)
    this.expectedModelPath = path.resolve(expectedModelPath)
    this.stopping = false
    this.loopPromise = undefined
    this.violations = []
    this.samples = 0
    this.maximumConcurrentLlamaServers = 0
    this.llama = undefined
    this.qwenWorkerPids = new Set()
    this.intervals = []
    this.activeInterval = undefined
    this.modelProbePromise = undefined
    this.latest = { llamaPids: [], qwenWorkerPids: [], locks: [] }
  }

  start() {
    this.loopPromise = this.loop()
  }

  async loop() {
    while (!this.stopping) {
      this.sample()
      await sleep(SAMPLE_INTERVAL_MS)
    }
  }

  sample() {
    const observedAtMonotonicNs = nsString()
    const processes = processSnapshot()
    const locks = kernelLockSnapshot(this.lockPath)
    this.latest = { ...processes, locks }
    this.samples += 1
    this.maximumConcurrentLlamaServers = Math.max(
      this.maximumConcurrentLlamaServers,
      processes.llamaPids.length,
    )
    if (processes.llamaPids.length > 1) {
      this.violations.push('more than one llama-server was observed')
    }
    if (locks.length > 1) this.violations.push('more than one holder owned the GPU flock')
    if (processes.llamaPids.length > 0 && locks[0]?.owner !== 'gemma') {
      this.violations.push('llama-server was observed without the Gemma kernel flock')
    }
    if (processes.llamaPids.length > 0 && processes.qwenWorkerPids.length > 0) {
      this.violations.push('llama-server and Qwen worker overlapped')
    }
    if (processes.llamaPids.length > 0 && locks[0]?.owner === 'qwen3-tts') {
      this.violations.push('llama-server overlapped the Qwen kernel flock')
    }

    for (const pid of processes.qwenWorkerPids) this.qwenWorkerPids.add(pid)
    const llamaPid = processes.llamaPids[0]
    if (llamaPid !== undefined) {
      if (this.llama === undefined) this.observeLlamaIdentity(llamaPid, observedAtMonotonicNs)
      if (this.llama.pid !== llamaPid)
        this.violations.push('llama-server PID changed within the run')
      this.llama.lastObservedAtMonotonicNs = observedAtMonotonicNs
    } else if (this.llama !== undefined && this.llama.deathObservedAtMonotonicNs === undefined) {
      if (!processAlive(this.llama.pid)) {
        this.llama.deathObservedAtMonotonicNs = observedAtMonotonicNs
      }
    }

    const lock = locks[0]
    if (
      this.activeInterval !== undefined &&
      (lock === undefined || lock.holderPid !== this.activeInterval.holderPid)
    ) {
      this.activeInterval.endedAtMonotonicNs = observedAtMonotonicNs
      this.activeInterval.releaseObserved = true
      this.activeInterval.holderAliveAfterRelease = processAlive(this.activeInterval.holderPid)
      this.activeInterval = undefined
    }
    if (lock !== undefined && this.activeInterval === undefined) {
      const interval = {
        owner: lock.owner,
        holderPid: lock.holderPid,
        mode: lock.mode,
        startedAtMonotonicNs: observedAtMonotonicNs,
        endedAtMonotonicNs: undefined,
        samples: 0,
        releaseObserved: false,
        holderAliveAfterRelease: undefined,
      }
      this.intervals.push(interval)
      this.activeInterval = interval
    }
    if (this.activeInterval !== undefined) this.activeInterval.samples += 1
    this.assertHealthy()
  }

  observeLlamaIdentity(pid, observedAtMonotonicNs) {
    const commandLine = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
    const executablePath = realpathSync(`/proc/${pid}/exe`)
    const modelPath = path.resolve(argumentAfter(commandLine, '--model') ?? '')
    const alias = argumentAfter(commandLine, '--alias')
    const keyPath = argumentAfter(commandLine, '--api-key-file')
    if (executablePath !== this.expectedBinary)
      fail('observed llama-server executable is not pinned')
    if (modelPath !== this.expectedModelPath) fail('observed llama-server GGUF path is not pinned')
    if (alias !== SELECTED_MODEL_ID) fail('observed llama-server alias is not the selected model')
    if (keyPath === undefined) fail('observed llama-server has no API key file')
    const processStartTimeTicks = parseProcStartTime(readFileSync(`/proc/${pid}/stat`, 'utf8'))
    this.llama = {
      pid,
      executablePath,
      processStartTimeTicks,
      firstObservedAtMonotonicNs: observedAtMonotonicNs,
      lastObservedAtMonotonicNs: observedAtMonotonicNs,
      deathObservedAtMonotonicNs: undefined,
      commandModelPath: modelPath,
      commandAlias: alias,
      listenerOwnedAtModelProbe: false,
      modelEndpointStatus: undefined,
      reportedModelIds: undefined,
    }
    this.modelProbePromise = this.probeModelEndpoint(pid, keyPath)
  }

  async probeModelEndpoint(pid, keyPath) {
    const deadline = performance.now() + 10 * 60_000
    while (performance.now() < deadline) {
      if (!processAlive(pid)) fail('llama-server exited before reporting its model identity')
      try {
        const apiKey = (await readFile(keyPath, 'utf8')).trim()
        if (apiKey.length < 16) throw new Error('key not ready')
        const response = await fetch(`${this.directorOrigin}/v1/models`, {
          headers: { authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(2_000),
        })
        if (response.ok) {
          const value = await response.json()
          const modelIds = Array.isArray(value?.data)
            ? value.data.map((item) => item?.id).filter((id) => typeof id === 'string')
            : []
          if (!modelIds.includes(SELECTED_MODEL_ID)) {
            fail('llama-server did not report the selected model id')
          }
          this.llama.modelEndpointStatus = response.status
          this.llama.reportedModelIds = modelIds
          this.llama.listenerOwnedAtModelProbe = listenerOwnedBy(this.directorPort, pid)
          if (!this.llama.listenerOwnedAtModelProbe) {
            fail('the model endpoint listener was not owned by the observed llama-server PID')
          }
          return
        }
      } catch {
        // Expected while the real server is loading and before the key file/endpoint is ready.
      }
      await sleep(250)
    }
    fail('llama-server never reported its model identity before the deadline')
  }

  async waitForClean(timeoutMs) {
    const deadline = performance.now() + timeoutMs
    while (performance.now() < deadline) {
      this.sample()
      if (
        this.latest.llamaPids.length === 0 &&
        this.latest.qwenWorkerPids.length === 0 &&
        this.latest.locks.length === 0
      ) {
        await sleep(250)
        this.sample()
        if (
          this.latest.llamaPids.length === 0 &&
          this.latest.qwenWorkerPids.length === 0 &&
          this.latest.locks.length === 0
        ) {
          return
        }
      }
      await sleep(100)
    }
    fail('model process or GPU flock did not become clean before the deadline')
  }

  assertHealthy() {
    if (this.violations.length > 0) fail(this.violations[0])
  }

  async stop() {
    this.stopping = true
    await this.loopPromise
    await this.modelProbePromise
    this.assertHealthy()
  }
}

const waitForChild = async (child, timeoutMs, spawnError) => {
  const deadline = performance.now() + timeoutMs
  while (child.exitCode === null && child.signalCode === null) {
    if (spawnError.current !== undefined) {
      fail(`real provenance driver failed to spawn: ${spawnError.current.message}`)
    }
    if (performance.now() >= deadline) fail('real provenance run exceeded its deadline')
    await sleep(100)
  }
  return child.exitCode
}

const stopChild = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    return
  }
  const deadline = performance.now() + 15_000
  while (performance.now() < deadline && child.exitCode === null && child.signalCode === null) {
    await sleep(100)
  }
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

const readReceipts = async (receiptPath) =>
  (await readFile(receiptPath, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))

const assertPortFree = async (port, label) => {
  if (!(await portIsFree(port))) fail(`${label} port ${port} is not free`)
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  if (existsSync(options.evidence)) fail(`evidence already exists: ${options.evidence}`)
  const { root: workspace } = await resolveSafeWorkspace({
    configured: options.workspace,
    prefix: 'lna-gemma-provenance-',
  })
  const lockPath = path.join(workspace, 'gpu', 'exclusive.lock')
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 })
  const { paths } = await resolveRealRuntimePaths({ ...process.env, LNA_GPU_LOCK: lockPath })
  await checkRealRuntimePaths(paths)

  const processesBefore = processSnapshot()
  if (processesBefore.llamaPids.length > 0 || processesBefore.qwenWorkerPids.length > 0) {
    fail('a model process is resident before the proof')
  }
  assertGpuIdle()
  await assertPortFree(3000, 'web')
  await assertPortFree(paths.directorPort, 'director')
  if (kernelLockSnapshot(path.resolve(lockPath)).length !== 0) fail('scratch GPU flock is held')
  const gpuBefore = gpuSnapshot()
  if (gpuBefore.memoryUsedMiB !== EXPECTED_IDLE_MEMORY_MIB) {
    fail(`GPU did not begin at the ${EXPECTED_IDLE_MEMORY_MIB} MiB idle baseline`)
  }

  const receiptPath = path.join(workspace, 'director-receipts.jsonl')
  const stdoutPath = path.join(workspace, 'driver.stdout.json')
  const stderrPath = path.join(workspace, 'driver.stderr.log')
  const stdoutStream = createWriteStream(stdoutPath, { flags: 'wx', mode: 0o600 })
  const stderrStream = createWriteStream(stderrPath, { flags: 'wx', mode: 0o600 })
  let stdout = ''
  const monitor = new RuntimeMonitor({
    lockPath,
    directorOrigin: new URL(paths.directorUrl).origin,
    expectedBinary: paths.llamaBinary,
    expectedModelPath: paths.gemmaModel,
  })
  monitor.sample()
  monitor.start()

  const child = spawn(
    'pnpm',
    [
      'pipeline:demo',
      '--',
      '--epub',
      ACCEPTANCE_M1_EPUB_PATH,
      '--transports',
      'real',
      '--workspace',
      workspace,
      '--job-id',
      `gemma-provenance-${randomUUID()}`,
      '--chapters',
      '1',
      '--passages',
      '1',
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
      lockPath,
    ],
    {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, LNA_DIRECTOR_RECEIPTS_PATH: receiptPath },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const spawnError = { current: undefined }
  child.once('error', (error) => {
    spawnError.current = error
  })
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk)
    stdoutStream.write(chunk)
  })
  child.stderr.pipe(stderrStream)

  let exitCode
  try {
    exitCode = await waitForChild(child, RUN_DEADLINE_MS, spawnError)
  } finally {
    await stopChild(child)
    stdoutStream.end()
    stderrStream.end()
    await monitor.waitForClean(60_000)
    await monitor.stop()
  }
  if (exitCode !== 0) fail(`real pipeline exited ${String(exitCode)}; see ${stderrPath}`)
  const reportStart = stdout.indexOf('{')
  if (reportStart === -1) fail('real pipeline emitted no JSON report')
  const report = JSON.parse(stdout.slice(reportStart))
  const rawReceipts = await readReceipts(receiptPath)
  if (rawReceipts.length === 0) fail('the real director produced zero request receipts')
  if (monitor.llama === undefined) fail('no real llama-server process was observed')
  if (monitor.llama.deathObservedAtMonotonicNs === undefined) {
    fail('llama-server death was not observed')
  }

  const gemmaIntervals = monitor.intervals.filter((interval) => interval.owner === 'gemma')
  const qwenIntervals = monitor.intervals.filter((interval) => interval.owner === 'qwen3-tts')
  if (gemmaIntervals.length !== 1 || qwenIntervals.length !== 1) {
    fail('the run did not expose exactly one Gemma and one Qwen flock interval')
  }
  const gemma = gemmaIntervals[0]
  const qwen = qwenIntervals[0]
  if (
    gemma.endedAtMonotonicNs === undefined ||
    qwen.endedAtMonotonicNs === undefined ||
    BigInt(gemma.endedAtMonotonicNs) > BigInt(qwen.startedAtMonotonicNs)
  ) {
    fail('Gemma and Qwen kernel-flock intervals overlap')
  }
  if (
    monitor.intervals.some(
      (interval) =>
        !interval.releaseObserved ||
        interval.holderAliveAfterRelease !== false ||
        interval.samples < 1,
    )
  ) {
    fail('a kernel-flock holder was not observed released and dead')
  }
  if (monitor.qwenWorkerPids.size === 0) fail('no real Qwen worker process was observed')

  const receiptKeys = [
    'completedAtMonotonicNs',
    'ordinal',
    'passageCount',
    'passageIds',
    'requestId',
    'requestSha256',
    'responseCompleted',
    'responseStatus',
    'schema',
    'startedAtMonotonicNs',
  ]
  const directorRequests = rawReceipts.map((receipt) => {
    if (Object.keys(receipt).sort().join(',') !== receiptKeys.join(',')) {
      fail('a director request receipt contains an unexpected or prose-bearing field')
    }
    return { ...receipt, llamaServerPid: monitor.llama.pid }
  })
  for (const receipt of directorRequests) {
    if (
      receipt.responseStatus !== 200 ||
      receipt.responseCompleted !== true ||
      receipt.passageCount < 1 ||
      receipt.passageIds.length !== receipt.passageCount ||
      BigInt(receipt.startedAtMonotonicNs) < BigInt(monitor.llama.firstObservedAtMonotonicNs) ||
      BigInt(receipt.completedAtMonotonicNs) > BigInt(monitor.llama.deathObservedAtMonotonicNs)
    ) {
      fail('a director request receipt is not bound to the observed llama-server lifetime')
    }
  }

  const processesAfter = processSnapshot()
  if (processesAfter.llamaPids.length > 0 || processesAfter.qwenWorkerPids.length > 0) {
    fail('a model process remains after the proof')
  }
  assertGpuIdle()
  await assertPortFree(3000, 'web')
  await assertPortFree(paths.directorPort, 'director')
  if (kernelLockSnapshot(path.resolve(lockPath)).length !== 0) fail('GPU flock remained held')
  if (existsSync(`${lockPath}.quarantined`)) fail('GPU quarantine marker remained')
  const gpuAfter = gpuSnapshot()
  if (
    gpuAfter.memoryUsedMiB !== EXPECTED_IDLE_MEMORY_MIB ||
    gpuAfter.memoryUsedMiB !== gpuBefore.memoryUsedMiB ||
    gpuAfter.utilizationPercent !== 0
  ) {
    fail('GPU did not return to the measured idle baseline')
  }

  const modelStats = await stat(paths.gemmaModel)
  if (modelStats.size !== GEMMA_MODEL_BYTES) fail('pinned GGUF byte size changed during the run')
  const fixtureBytes = await readFile(ACCEPTANCE_M1_EPUB_PATH)
  const evidence = {
    schema: 'issue-21-gemma-provenance@1',
    generatedAt: new Date().toISOString(),
    fixture: {
      sha256: createHash('sha256').update(fixtureBytes).digest('hex'),
      byteLength: fixtureBytes.byteLength,
      slice: { firstChapter: 1, maxChapters: 1, maxPassagesPerChapter: 1 },
    },
    sampling: { intervalMs: SAMPLE_INTERVAL_MS, samples: monitor.samples },
    llamaServer: {
      ...monitor.llama,
      pinnedGgufPath: paths.gemmaModel,
      pinnedGgufByteLength: modelStats.size,
    },
    directorRequests,
    kernelFlockIntervals: monitor.intervals,
    qwen: { workerPids: [...monitor.qwenWorkerPids] },
    run: {
      state: report.jobState,
      stage: report.jobStage,
      generatedSegments: report.generatedSegments,
      reusedSegments: report.reusedSegments,
      m4bBytes: report.m4bBytes,
      m4bSha256: report.m4bSha256,
    },
    cleanup: {
      gpuBefore,
      gpuAfter,
      expectedIdleMemoryMiB: EXPECTED_IDLE_MEMORY_MIB,
      modelProcessesRemaining: 0,
      kernelFlockHoldersRemaining: 0,
      webPortFree: true,
      directorPortFree: true,
      quarantineMarkerPresent: false,
    },
    assertions: {
      realLlamaServerObserved: true,
      listenerOwnedByObservedLlamaServer: monitor.llama.listenerOwnedAtModelProbe,
      selectedModelReportedByServer:
        monitor.llama.reportedModelIds?.includes(SELECTED_MODEL_ID) === true,
      directorRequestCount: directorRequests.length,
      everyDirectorRequestServedByObservedLlamaServer: true,
      gemmaFlockHolderPid: gemma.holderPid,
      qwenFlockHolderPid: qwen.holderPid,
      gemmaAndQwenIntervalsDisjoint: true,
      llamaDeadBeforeQwen:
        BigInt(monitor.llama.deathObservedAtMonotonicNs) <= BigInt(qwen.startedAtMonotonicNs),
      noLlamaQwenCoResidency: true,
      postRunClean: true,
    },
  }
  if (!evidence.assertions.llamaDeadBeforeQwen) fail('llama-server was not dead before Qwen')
  await writeFile(options.evidence, `${JSON.stringify(evidence, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o644,
  })
  console.log(`[gemma-provenance] evidence=${options.evidence}`)
  console.log('[gemma-provenance] GREEN: real request/process/flock provenance persisted')
}

export { kernelLockSnapshot, processSnapshot, RuntimeMonitor }

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(
      `[gemma-provenance] RED: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 1
  })
}
