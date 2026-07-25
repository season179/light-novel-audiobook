import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LoadedProductionConfig } from '../src/config.js'
import { loadProductionConfig } from '../src/config.js'
import type { RenderIdentity, SegmentPlan } from '../src/manifest.js'
import {
  canonicalJson,
  createSegmentPlan,
  recordRendered,
  sha256,
  tryReuse,
} from '../src/manifest.js'
import type { QwenWorkerRuntimeIdentity } from '../src/runtime-identity.js'
import type { SpeechEngineError, SpeechSegmentRequest } from '../src/types.js'

const deepGate = vi.hoisted(() => ({ calls: 0 }))

// Counts the per-sample RMS/clipping analysis so reuse can prove it does not rerun it.
vi.mock('../src/wav.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/wav.js')>()
  return {
    ...actual,
    validateCanonicalWav: async (...args: Parameters<typeof actual.validateCanonicalWav>) => {
      deepGate.calls += 1
      return actual.validateCanonicalWav(...args)
    },
  }
})

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PRODUCTION_CONFIG = join(PACKAGE_ROOT, '../../config/qwen3-tts-production.json')

const RUNTIME_IDENTITY: QwenWorkerRuntimeIdentity = Object.freeze({
  workerSha256: 'a'.repeat(64),
  pythonExecutableSha256: 'b'.repeat(64),
  runtimeManifestSha256: 'c'.repeat(64),
  uvLockSha256: 'd'.repeat(64),
  installedPackagesSha256: 'e'.repeat(64),
  imports: Object.freeze({ qwenTts: '0.1.1', torch: '2.9.1', torchaudio: '2.9.1' }),
})

const REQUEST: SpeechSegmentRequest = {
  segmentId: 'book-0123456789abcdef01234567-ch0001-p000001-s0001',
  text: 'The cached clip must stay byte identical.',
  voiceProfileId: 'aiden-calm-narrator',
}

function canonicalWav(text: string): Buffer {
  const words = text.trim().split(/\s+/u).length
  const sampleRate = 24_000
  const frames = Math.max(2_880, Math.round(words * sampleRate * 0.12))
  const bytes = Buffer.alloc(44 + frames * 2)
  bytes.write('RIFF', 0)
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WAVE', 8)
  bytes.write('fmt ', 12)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(sampleRate, 24)
  bytes.writeUInt32LE(sampleRate * 2, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(frames * 2, 40)
  for (let frame = 0; frame < frames; frame += 1) {
    bytes.writeInt16LE(
      Math.round(Math.sin((frame * Math.PI * 2 * 220) / sampleRate) * 5_000),
      44 + frame * 2,
    )
  }
  return bytes
}

const directories: Array<string> = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function renderOnce(
  runtimeIdentity: QwenWorkerRuntimeIdentity = RUNTIME_IDENTITY,
): Promise<{ config: LoadedProductionConfig; plan: SegmentPlan; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'qwen-tts-reuse-'))
  directories.push(directory)
  const output = join(directory, 'audio')
  await mkdir(output, { recursive: true })
  const config = await loadProductionConfig(PRODUCTION_CONFIG)
  const plan = createSegmentPlan(1, REQUEST, output, config, runtimeIdentity)
  const bytes = canonicalWav(REQUEST.text)
  await writeFile(plan.wavPath, bytes, { mode: 0o600 })
  await recordRendered(plan, config, sha256(bytes))
  return { config, plan, directory }
}

describe('render manifest reuse', () => {
  it('reuses a cached clip on its content address without rerunning the deep audio gate', async () => {
    const { config, plan } = await renderOnce()
    expect(deepGate.calls).toBe(1)

    const reused = await tryReuse(plan, config)

    expect(reused?.status).toBe('reused')
    expect(reused?.audio.sha256).toBe(sha256(canonicalWav(REQUEST.text)))
    expect(deepGate.calls, 'reuse must not reanalyze every sample of every cached WAV').toBe(1)
  })

  it('invalidates reuse when the pinned worker runtime identity changes', async () => {
    const { config, plan, directory } = await renderOnce()
    const edited = createSegmentPlan(1, REQUEST, join(directory, 'audio'), config, {
      ...RUNTIME_IDENTITY,
      workerSha256: 'f'.repeat(64),
    })

    expect(plan.identitySha256).not.toBe(edited.identitySha256)
    expect(await tryReuse(edited, config)).toBeUndefined()
    expect(await tryReuse(plan, config)).toBeDefined()
  })

  it('binds the whole pinned runtime identity, not just the worker script', async () => {
    const identity = (plan: SegmentPlan): RenderIdentity => plan.identity
    const { config, plan, directory } = await renderOnce()
    const output = join(directory, 'audio')
    for (const field of [
      'pythonExecutableSha256',
      'runtimeManifestSha256',
      'uvLockSha256',
      'installedPackagesSha256',
    ] as const) {
      const changed = createSegmentPlan(1, REQUEST, output, config, {
        ...RUNTIME_IDENTITY,
        [field]: '9'.repeat(64),
      })
      expect(canonicalJson(identity(changed))).not.toBe(canonicalJson(identity(plan)))
      expect(await tryReuse(changed, config), `${field} must invalidate reuse`).toBeUndefined()
    }
  })

  it('rejects a manifest whose recorded audio identity contradicts the pinned WAV requirements', async () => {
    const { config, plan } = await renderOnce()
    const manifest = JSON.parse(await readFile(plan.manifestPath, 'utf8')) as {
      audio: { sampleRateHz: number }
    }
    manifest.audio.sampleRateHz = 48_000
    await writeFile(plan.manifestPath, `${canonicalJson(manifest)}\n`)

    expect(await tryReuse(plan, config)).toBeUndefined()
  })

  it('surfaces an unreadable cached WAV instead of silently rerendering it', async () => {
    const { config, plan } = await renderOnce()
    await chmod(plan.wavPath, 0o000)
    try {
      const error = (await tryReuse(plan, config).then(
        () => undefined,
        (thrown: unknown) => thrown,
      )) as SpeechEngineError | undefined
      expect(error?.code).toBe('audio-validation')
      expect(error?.message).toContain('Cannot read cached WAV')
    } finally {
      await chmod(plan.wavPath, 0o600)
    }
  })
})
