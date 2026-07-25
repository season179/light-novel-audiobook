import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  FileGpuLeaseCoordinator,
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
  const requests = [
    {
      segmentId: 'ch99-9001',
      text: 'Morning light crossed the quiet library floor.',
      voiceProfileId: 'aiden-calm-narrator',
    },
    {
      segmentId: 'ch99-9002',
      text: 'We found it! Hurry, before the doors close!',
      voiceProfileId: 'ryan-energetic-baseline',
    },
    {
      segmentId: 'ch99-9003',
      text: 'I have carried this promise for far too long.',
      voiceProfileId: 'ryan-low-weary',
    },
  ] as const

  const engine = await QwenTtsSpeechEngine.create(baseConfig)
  const first = await engine.renderBatch(requests, {
    onProgress: (event) => {
      process.stderr.write(`[qwen-smoke] ${JSON.stringify(event)}\n`)
    },
  })
  if (first.rendered !== 3) {
    throw new Error(
      'Smoke output already existed; use a new empty output root so all three profiles render',
    )
  }

  const restarted = await QwenTtsSpeechEngine.create(baseConfig)
  const resumed = await restarted.renderBatch(requests)
  if (resumed.reused !== 3 || resumed.rendered !== 0) {
    throw new Error('Restart reuse check failed')
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        status: 'passed',
        rendered: first.rendered,
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
