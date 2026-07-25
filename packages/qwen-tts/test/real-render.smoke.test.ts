import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FileGpuLeaseCoordinator, QwenTtsSpeechEngine } from '../src/index.js'

/**
 * The only suite that loads the real pinned Qwen3-TTS model and renders through the real Python
 * worker. Three blockers in a row (#59, the stdout banner #62, and the SoX question) were each
 * invisible until a real render was attempted, because no test or CI step exercised this path. This
 * stops that recurring by rendering one short segment end to end whenever the pinned runtime and a
 * GPU are present, and skipping -- loudly -- everywhere else.
 *
 * Gating follows the pinned-ffmpeg integration suite (`describe.skipIf(!PRESENT)` plus a stderr
 * `[skipped]` line, because Vitest hides console output from a file whose tests are all skipped).
 */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = resolve(PACKAGE_ROOT, '../..')
const PRODUCTION_CONFIG = join(REPO, 'config/qwen3-tts-production.json')
const SHARE = join(homedir(), '.local/share/light-novel-audiobook')
const LEASE_PATH = join(homedir(), '.local/state/light-novel-audiobook/gpu/exclusive.lock')

// Derive the pinned runtime/snapshot dirs from the config so the probe tracks the pinned revision
// and uv-lock hash rather than hardcoding them.
const configJson = JSON.parse(readFileSync(PRODUCTION_CONFIG, 'utf8')) as {
  runtime: { uvLockSha256: string }
  model: { revision: string }
}
const RUNTIME_ROOT = join(SHARE, 'runtimes/tts/qwen3-tts', configJson.runtime.uvLockSha256)
const SNAPSHOT = join(
  SHARE,
  'models/tts/qwen3-tts-custom-voice',
  configJson.model.revision,
  'snapshot',
)

const isWsl2 =
  process.platform === 'linux' && /microsoft.*wsl2/i.test(readFileSync('/proc/version', 'utf8'))

const runtimePresent =
  existsSync(join(RUNTIME_ROOT, 'bin/python')) &&
  existsSync(join(RUNTIME_ROOT, 'manifest.json')) &&
  existsSync(join(SNAPSHOT, 'model.safetensors'))

function nvidiaGpuPresent(): boolean {
  try {
    const out = execFileSync(
      'nvidia-smi',
      ['--query-gpu=memory.total', '--format=csv,noheader,nounits'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
    return out
      .split(/\r?\n/u)
      .map((line) => Number(line.trim()))
      .some((value) => Number.isFinite(value) && value > 0)
  } catch {
    return false
  }
}

const gpuPresent = isWsl2 && nvidiaGpuPresent()
const AVAILABLE = isWsl2 && runtimePresent && gpuPresent

const missing: string[] = []
if (!isWsl2) missing.push('host is not WSL2')
if (!runtimePresent) missing.push(`pinned runtime/snapshot not found under ${SHARE}`)
if (!gpuPresent) missing.push('no NVIDIA GPU visible to nvidia-smi')
const SKIP_REASON = missing.join('; ')

if (!AVAILABLE) {
  process.stderr.write(
    `[skipped] real Qwen3-TTS worker render coverage did not run: ${SKIP_REASON}.\n` +
      `[skipped] Expected on CI and any host without the pinned TTS runtime + GPU.\n`,
  )
}

describe.skipIf(!AVAILABLE)(
  AVAILABLE
    ? 'real Qwen3-TTS worker render (smoke)'
    : `real Qwen3-TTS worker render (smoke) [SKIPPED: ${SKIP_REASON}]`,
  () => {
    let outputDirectory: string

    beforeAll(async () => {
      // Must be outside Git and on ext4; /tmp under WSL2 is ext4.
      outputDirectory = await mkdtemp(join(tmpdir(), 'qwen-real-smoke-'))
    })

    afterAll(async () => {
      if (outputDirectory !== undefined) await rm(outputDirectory, { recursive: true, force: true })
    })

    // Short synthetic narrator line (NOT book text -- this file is committed and the book is
    // copyrighted). Renders in a few seconds, well under the 30 s ceiling, so the smoke test
    // exercises the transport and the gate without entangling the length question (#55).
    it('renders one short narrator segment through the pinned worker end to end', async () => {
      const engine = await QwenTtsSpeechEngine.create({
        pythonExecutable: join(RUNTIME_ROOT, 'bin/python'),
        workerScriptPath: join(PACKAGE_ROOT, 'python/qwen_batch_worker.py'),
        productionConfigPath: PRODUCTION_CONFIG,
        modelLockPath: join(REPO, 'config/qwen3-tts-custom-voice.lock.json'),
        runtimeManifestPath: join(RUNTIME_ROOT, 'manifest.json'),
        uvLockPath: join(REPO, 'scripts/qwen3-tts-runtime/uv.lock'),
        snapshotPath: SNAPSHOT,
        outputDirectory,
        repositoryRoot: REPO,
        gpuGate: new FileGpuLeaseCoordinator({ lockFilePath: LEASE_PATH }),
        allowOverwriteExisting: false,
      })

      // Issue #29 stable id form so the engine accepts it without test-only unscoped ids.
      const SMOKE_BOOK = '5170e0000000000000009901'
      const result = await engine.renderBatch([
        {
          segmentId: `book-${SMOKE_BOOK}-ch0099-p000001-s0001`,
          text: 'Morning light crossed the quiet library floor.',
          voiceProfileId: 'aiden-calm-narrator',
        },
      ])

      expect(result.rendered).toBe(1)
      const rendered = result.results[0]
      expect(rendered).toBeDefined()
      if (rendered === undefined) throw new Error('expected one rendered result')
      expect(rendered.audio.sampleRateHz).toBe(24_000)
      expect(rendered.audio.channels).toBe(1)
      expect(rendered.audio.durationSeconds).toBeGreaterThan(0)
      expect(existsSync(rendered.wavPath)).toBe(true)
    }, 240_000)
  },
)
