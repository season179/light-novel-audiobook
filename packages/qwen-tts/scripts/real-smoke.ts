import { execFile } from 'node:child_process'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  FileGpuLeaseCoordinator,
  loadProductionConfig,
  prepareEmptySmokeOutputRoot,
  QwenTtsSpeechEngine,
  SpeechEngineError,
} from '../src/index.js'

const execFileAsync = promisify(execFile)
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPOSITORY_ROOT = resolve(PACKAGE_ROOT, '../..')

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return resolve(value)
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

async function main(): Promise<void> {
  if (process.env.QWEN3_TTS_REAL_SMOKE !== '1') {
    throw new Error('Real GPU inference is opt-in; set QWEN3_TTS_REAL_SMOKE=1')
  }
  const isWsl2 =
    process.platform === 'linux' &&
    /microsoft.*wsl2/iu.test(await readFile('/proc/version', 'utf8'))
  const isAppleSilicon = process.platform === 'darwin' && process.arch === 'arm64'
  if (!isWsl2 && !isAppleSilicon) {
    throw new Error('The pinned Qwen real smoke command requires WSL2 or Apple Silicon macOS')
  }

  const runtimeRoot = required('QWEN3_TTS_RUNTIME_ROOT')
  const snapshotPath = required('QWEN3_TTS_MODEL_SNAPSHOT')
  const runtimeManifestPath = process.env.QWEN3_TTS_RUNTIME_MANIFEST
    ? required('QWEN3_TTS_RUNTIME_MANIFEST')
    : join(runtimeRoot, 'manifest.json')
  const outputDirectory = required('QWEN3_TTS_SMOKE_OUTPUT_ROOT')
  const lockDirectory = required('QWEN3_TTS_GPU_LEASE_PATH')
  if (contains(REPOSITORY_ROOT, outputDirectory) || contains(outputDirectory, REPOSITORY_ROOT)) {
    throw new Error('QWEN3_TTS_SMOKE_OUTPUT_ROOT must be outside Git')
  }
  await prepareEmptySmokeOutputRoot(outputDirectory)
  if (isWsl2) {
    const { stdout: filesystem } = await execFileAsync('findmnt', [
      '-n',
      '-o',
      'FSTYPE',
      '-T',
      outputDirectory,
    ])
    if (filesystem.trim() !== 'ext4') throw new Error('Real smoke output must be on WSL ext4')
  }

  const gpuGate = new FileGpuLeaseCoordinator({ lockFilePath: lockDirectory })
  const baseConfig = {
    pythonExecutable: join(runtimeRoot, 'bin/python'),
    workerScriptPath: join(PACKAGE_ROOT, 'python/qwen_batch_worker.py'),
    productionConfigPath: join(REPOSITORY_ROOT, 'config/qwen3-tts-production.json'),
    modelLockPath: join(REPOSITORY_ROOT, 'config/qwen3-tts-custom-voice.lock.json'),
    runtimeManifestPath,
    uvLockPath: join(REPOSITORY_ROOT, 'scripts/qwen3-tts-runtime/uv.lock'),
    snapshotPath,
    outputDirectory,
    repositoryRoot: REPOSITORY_ROOT,
    gpuGate,
    allowOverwriteExisting: false,
  } as const
  // Book-scoped issue #29 stable IDs; the adapter refuses unscoped IDs outside test fixtures.
  const SMOKE_BOOK = 'book-5170e0000000000000009901'
  /**
   * The original synthetic issue #105 transcript, not book text. It passed the committed MPS WAV
   * bounds for every built-in speaker. Holding text constant also makes the distinct-waveform gate
   * test profile material rather than merely observing that different sentences sound different.
   */
  const SMOKE_TEXT =
    'The market square was quiet at dawn, and the fountain held the first light. Then the bells began, every tower at once, and she knew the long wait was over.'
  const production = await loadProductionConfig(baseConfig.productionConfigPath)
  const profiles = [...production.selectedProfiles.values()]
  const requests = profiles.map((profile, index) => ({
    segmentId: `${SMOKE_BOOK}-ch0099-p${String(index + 1).padStart(6, '0')}-s0001`,
    text: SMOKE_TEXT,
    voiceProfileId: profile.id,
  }))

  const engine = await QwenTtsSpeechEngine.create(baseConfig)
  if (process.env.QWEN3_TTS_REAL_CANCELLATION === '1') {
    const controller = new AbortController()
    try {
      await engine.renderBatch([requests[0] as (typeof requests)[number]], {
        signal: controller.signal,
        onProgress: (event) => {
          process.stderr.write(`[qwen-cancellation-smoke] ${JSON.stringify(event)}\n`)
          if (event.type === 'segment-started') controller.abort()
        },
      })
      throw new Error('Real cancellation smoke unexpectedly completed a render')
    } catch (error) {
      if (!(error instanceof SpeechEngineError) || error.code !== 'cancelled') throw error
    }
    // `renderBatch` returns only after worker close and lease release. Reacquisition proves the
    // cancellation path did not leave either resource held by a resident Qwen worker.
    const successor = await gpuGate.acquire('qwen3-tts')
    await successor.release()
    process.stdout.write(
      `${JSON.stringify({ status: 'passed', cancelledDuring: 'segment-render', leaseReacquired: true }, null, 2)}\n`,
    )
    return
  }

  const first = await engine.renderBatch(requests, {
    onProgress: (event) => {
      process.stderr.write(`[qwen-smoke] ${JSON.stringify(event)}\n`)
    },
  })
  if (first.rendered !== requests.length) {
    throw new Error(
      `Smoke output already existed; use a new empty output root so all ${requests.length} profiles render`,
    )
  }
  // Every profile must have produced its own audio. Two profiles rendering identical bytes would mean
  // the inventory advertises voices it does not have — the exact drift #92's guards target, observed
  // here against the real model rather than against the lock table.
  const distinctAudio = new Set(first.results.map((result) => result.audio.sha256))
  if (distinctAudio.size !== requests.length) {
    throw new Error(
      `Only ${distinctAudio.size} distinct waveforms for ${requests.length} profiles: two approved voices render the same audio`,
    )
  }

  const restarted = await QwenTtsSpeechEngine.create(baseConfig)
  const resumed = await restarted.renderBatch(requests)
  if (resumed.reused !== requests.length || resumed.rendered !== 0) {
    throw new Error('Restart reuse check failed')
  }

  const missing = resumed.results[0]
  const corrupt = resumed.results[1]
  if (missing === undefined || corrupt === undefined) {
    throw new Error('Smoke inventory must have two outputs for recovery verification')
  }
  await Promise.all([unlink(missing.wavPath), writeFile(corrupt.wavPath, 'corrupt')])
  const recovering = await QwenTtsSpeechEngine.create({
    ...baseConfig,
    // Normal production atomically replaces stale output. Initial smoke creation remains no-replace.
    allowOverwriteExisting: true,
  })
  const recovered = await recovering.renderBatch(requests)
  if (recovered.rendered !== 2 || recovered.reused !== requests.length - 2) {
    throw new Error('Missing/corrupt restart recovery check failed')
  }
  const rerendered = recovered.results
    .filter((result) => result.status === 'rendered')
    .map((result) => result.segmentId)
  if (!rerendered.includes(missing.segmentId) || !rerendered.includes(corrupt.segmentId)) {
    throw new Error('Recovery rerendered the wrong segment identities')
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        status: 'passed',
        rendered: first.rendered,
        distinctWaveforms: distinctAudio.size,
        reusedAfterRestart: resumed.reused,
        recovery: {
          rerenderedMissingOrCorrupt: rerendered,
          rendered: recovered.rendered,
          reused: recovered.reused,
        },
        outputs: recovered.results.map((result) => ({
          segmentId: result.segmentId,
          voiceProfileId: result.voiceProfileId,
          wavPath: result.wavPath,
          sha256: result.audio.sha256,
          durationSeconds: result.audio.durationSeconds,
        })),
      },
      null,
      2,
    )}\n`,
  )
}

await main()
