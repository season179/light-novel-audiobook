import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  FileGpuLeaseCoordinator,
  loadProductionConfig,
  prepareEmptySmokeOutputRoot,
  QwenTtsSpeechEngine,
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
  if (
    process.platform !== 'linux' ||
    !/microsoft.*wsl2/iu.test(await readFile('/proc/version', 'utf8'))
  ) {
    throw new Error('The pinned Qwen real smoke command requires WSL2')
  }

  const runtimeRoot = required('QWEN3_TTS_RUNTIME_ROOT')
  const snapshotPath = required('QWEN3_TTS_MODEL_SNAPSHOT')
  const outputDirectory = required('QWEN3_TTS_SMOKE_OUTPUT_ROOT')
  const lockDirectory = required('QWEN3_TTS_GPU_LEASE_PATH')
  if (contains(REPOSITORY_ROOT, outputDirectory) || contains(outputDirectory, REPOSITORY_ROOT)) {
    throw new Error('QWEN3_TTS_SMOKE_OUTPUT_ROOT must be outside Git')
  }
  await prepareEmptySmokeOutputRoot(outputDirectory)
  const { stdout: filesystem } = await execFileAsync('findmnt', [
    '-n',
    '-o',
    'FSTYPE',
    '-T',
    outputDirectory,
  ])
  if (filesystem.trim() !== 'ext4') throw new Error('Real smoke output must be on WSL ext4')

  const baseConfig = {
    pythonExecutable: join(runtimeRoot, 'bin/python'),
    workerScriptPath: join(PACKAGE_ROOT, 'python/qwen_batch_worker.py'),
    productionConfigPath: join(REPOSITORY_ROOT, 'config/qwen3-tts-production.json'),
    modelLockPath: join(REPOSITORY_ROOT, 'config/qwen3-tts-custom-voice.lock.json'),
    runtimeManifestPath: join(runtimeRoot, 'manifest.json'),
    uvLockPath: join(REPOSITORY_ROOT, 'scripts/qwen3-tts-runtime/uv.lock'),
    snapshotPath,
    outputDirectory,
    repositoryRoot: REPOSITORY_ROOT,
    gpuGate: new FileGpuLeaseCoordinator({ lockFilePath: lockDirectory }),
    allowOverwriteExisting: false,
  } as const
  // Book-scoped issue #29 stable IDs; the adapter refuses unscoped IDs outside test fixtures.
  const SMOKE_BOOK = 'book-5170e0000000000000009901'
  /**
   * Derived from the pinned config rather than listed here, so a profile added to the approved
   * inventory cannot skip real-GPU coverage. Issue #92 added seven, and a hardcoded list of three
   * would have shipped them unrendered: the model would only be asked for a speaker string like
   * `uncle_fu` for the first time on someone's book, with 3.4 GB of weights already resident.
   *
   * Lines are written for this smoke test. Nothing here comes from any book.
   */
  const SMOKE_LINES = [
    'Morning light crossed the quiet library floor.',
    'We found it! Hurry, before the doors close!',
    'I have carried this promise for far too long.',
    'The letter arrived three days after the funeral.',
    'Do you really expect me to believe that?',
    'Every window on the street was dark by then.',
    'She counted the coins twice, then once more.',
    'Nothing about this arrangement was ever fair.',
    'The train was late, as it always was.',
    'He set the cup down without saying a word.',
  ] as const
  const production = await loadProductionConfig(baseConfig.productionConfigPath)
  const profiles = [...production.value.voiceProfiles]
  if (profiles.length > SMOKE_LINES.length) {
    throw new Error(
      `The pinned config has ${profiles.length} profiles but only ${SMOKE_LINES.length} smoke lines exist`,
    )
  }
  const requests = profiles.map((profile, index) => ({
    segmentId: `${SMOKE_BOOK}-ch0099-p${String(index + 1).padStart(6, '0')}-s0001`,
    text: SMOKE_LINES[index] as string,
    voiceProfileId: profile.id,
  }))

  const engine = await QwenTtsSpeechEngine.create(baseConfig)
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
  process.stdout.write(
    `${JSON.stringify(
      {
        status: 'passed',
        rendered: first.rendered,
        distinctWaveforms: distinctAudio.size,
        reusedAfterRestart: resumed.reused,
        outputs: first.results.map((result) => ({
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
