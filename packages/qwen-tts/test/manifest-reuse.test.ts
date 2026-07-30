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
  deriveSeed,
  MAX_SEED_ATTEMPTS,
  recordRendered,
  sha256,
  tryReuse,
} from '../src/manifest.js'
import type { QwenWorkerRuntimeIdentity } from '../src/runtime-identity.js'
import { AFFINE_WAV_GATE_REUSE_MIGRATION } from '../src/runtime-identity.js'
import type { SpeechEngineError, SpeechSegmentRequest } from '../src/types.js'
import { readCanonicalWavHeader } from '../src/wav.js'

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

const PREDECESSOR_CONFIG_SHA256 = '82f9a62a94a62bcf68e5d35709e358ffb552e380d1295a8e7b014dc82a219f25'
const PREDECESSOR_WORKER_SHA256 = '966d089fc0a65d63bcdd6a3d99f6baebd32e93bf054d0d67aa6f2b4050f02ca7'
const SUCCESSOR_WORKER_SHA256 = '9736166166ecf73cef3506f6cfa9e80e16eeb9bd5e532bc032fad54b0440d113'

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
  deepGate.calls = 0
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function renderOnce(
  runtimeIdentity: QwenWorkerRuntimeIdentity = RUNTIME_IDENTITY,
  attempt = 1,
  request: SpeechSegmentRequest = REQUEST,
): Promise<{ config: LoadedProductionConfig; plan: SegmentPlan; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'qwen-tts-reuse-'))
  directories.push(directory)
  const output = join(directory, 'audio')
  await mkdir(output, { recursive: true })
  const config = await loadProductionConfig(PRODUCTION_CONFIG)
  const plan = createSegmentPlan(1, request, output, config, runtimeIdentity, attempt)
  const bytes = canonicalWav(request.text)
  await writeFile(plan.wavPath, bytes, { mode: 0o600 })
  await recordRendered(plan, config, sha256(bytes))
  return { config, plan, directory }
}

describe('render manifest reuse', () => {
  it('pins the canonical seed and plan identity while deriving the reviewed attempt family', async () => {
    const config = await loadProductionConfig(PRODUCTION_CONFIG)
    const profile = config.selectedProfiles.get('ryan-low-weary')
    if (profile === undefined) throw new Error('Pinned profile missing')
    const segmentId = 'book-ca2ed4f871d99b32da10361c-ch0003-p000027-s0001'
    const request: SpeechSegmentRequest = {
      segmentId,
      text: 'Synthetic seed identity fixture.',
      voiceProfileId: 'ryan-low-weary',
    }

    expect(
      Array.from({ length: MAX_SEED_ATTEMPTS }, (_unused, index) =>
        deriveSeed(profile, segmentId, index + 1),
      ),
    ).toEqual([408223135, 2104183315, 1460219530, 1087971059])
    const implicit = createSegmentPlan(1, request, '/tmp/qwen', config, RUNTIME_IDENTITY)
    const explicit = createSegmentPlan(1, request, '/tmp/qwen', config, RUNTIME_IDENTITY, 1)
    expect(canonicalJson(explicit)).toBe(canonicalJson(implicit))
    expect(implicit.identitySha256).toBe(
      '2fc06cdf22ead151cf6a880300a9341a4a9c1ddefe828dba88c28318f9d8196b',
    )
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid seed attempt %s',
    async (attempt) => {
      const config = await loadProductionConfig(PRODUCTION_CONFIG)
      const profile = config.selectedProfiles.get('ryan-low-weary')
      if (profile === undefined) throw new Error('Pinned profile missing')
      expect(() => deriveSeed(profile, REQUEST.segmentId, attempt)).toThrow('positive safe integer')
    },
  )

  it('accepts only exact attempt-family manifests and returns their truthful identity hash', async () => {
    for (let attempt = 1; attempt <= MAX_SEED_ATTEMPTS; attempt += 1) {
      const { config, plan: rendered, directory } = await renderOnce(RUNTIME_IDENTITY, attempt)
      const canonical = createSegmentPlan(
        1,
        REQUEST,
        join(directory, 'audio'),
        config,
        RUNTIME_IDENTITY,
      )
      const reused = await tryReuse(canonical, config)
      expect(reused?.renderIdentitySha256).toBe(rendered.identitySha256)
      if (attempt > 1) expect(reused?.renderIdentitySha256).not.toBe(canonical.identitySha256)
    }
  })

  it('rejects attempt 5 and a recomputed near-family seed', async () => {
    const attemptFive = await renderOnce(RUNTIME_IDENTITY, MAX_SEED_ATTEMPTS + 1)
    const canonicalFive = createSegmentPlan(
      1,
      REQUEST,
      join(attemptFive.directory, 'audio'),
      attemptFive.config,
      RUNTIME_IDENTITY,
    )
    expect(await tryReuse(canonicalFive, attemptFive.config)).toBeUndefined()

    const attemptTwo = await renderOnce(RUNTIME_IDENTITY, 2)
    const manifest = JSON.parse(await readFile(attemptTwo.plan.manifestPath, 'utf8')) as {
      renderIdentitySha256: string
      renderIdentity: RenderIdentity
    }
    const nearIdentity: RenderIdentity = {
      ...manifest.renderIdentity,
      settings: { ...manifest.renderIdentity.settings, seed: attemptTwo.plan.seed + 1 },
    }
    manifest.renderIdentity = nearIdentity
    manifest.renderIdentitySha256 = sha256(canonicalJson(nearIdentity))
    await writeFile(attemptTwo.plan.manifestPath, `${canonicalJson(manifest)}\n`)
    const canonicalTwo = createSegmentPlan(
      1,
      REQUEST,
      join(attemptTwo.directory, 'audio'),
      attemptTwo.config,
      RUNTIME_IDENTITY,
    )
    expect(await tryReuse(canonicalTwo, attemptTwo.config)).toBeUndefined()
  })

  it('rejects non-seed identity changes and canonical JSON/hash disagreement', async () => {
    const mutation = await renderOnce(RUNTIME_IDENTITY, 2)
    const canonical = createSegmentPlan(
      1,
      REQUEST,
      join(mutation.directory, 'audio'),
      mutation.config,
      RUNTIME_IDENTITY,
    )
    const manifest = JSON.parse(await readFile(mutation.plan.manifestPath, 'utf8')) as {
      renderIdentitySha256: string
      renderIdentity: RenderIdentity
    }
    const changed: RenderIdentity = {
      ...manifest.renderIdentity,
      delivery: { ...manifest.renderIdentity.delivery, emotion: 'different-fixture-emotion' },
    }
    manifest.renderIdentity = changed
    manifest.renderIdentitySha256 = sha256(canonicalJson(changed))
    await writeFile(mutation.plan.manifestPath, `${canonicalJson(manifest)}\n`)
    expect(await tryReuse(canonical, mutation.config)).toBeUndefined()

    const disagreement = await renderOnce(RUNTIME_IDENTITY, 2)
    const mismatched = JSON.parse(await readFile(disagreement.plan.manifestPath, 'utf8')) as {
      renderIdentitySha256: string
    }
    mismatched.renderIdentitySha256 = 'f'.repeat(64)
    await writeFile(disagreement.plan.manifestPath, `${canonicalJson(mismatched)}\n`)
    const disagreementCanonical = createSegmentPlan(
      1,
      REQUEST,
      join(disagreement.directory, 'audio'),
      disagreement.config,
      RUNTIME_IDENTITY,
    )
    expect(await tryReuse(disagreementCanonical, disagreement.config)).toBeUndefined()
  })

  it('reuses a cached clip on its content address without rerunning the deep audio gate', async () => {
    const { config, plan } = await renderOnce()
    expect(deepGate.calls).toBe(1)

    const reused = await tryReuse(plan, config)

    expect(reused?.status).toBe('reused')
    expect(reused?.audio.sha256).toBe(sha256(canonicalWav(REQUEST.text)))
    expect(deepGate.calls, 'reuse must not reanalyze every sample of every cached WAV').toBe(1)
  })

  /**
   * The #91 affine-gate migration is spent. It was bounded to one exact pair of production-config
   * hashes, and issue #92 changed the config to admit seven more approved speakers, so `config.sha256`
   * no longer equals its `successorProductionConfigSha256` and the bridge can never fire again — which
   * is precisely what its own comment promised ("any future worker hash remains identity-invalidating").
   *
   * That is the safe direction: reuse falls back to strict identity, so pre-#92 artifacts are
   * re-rendered rather than served under a config that no longer describes them. This test now pins the
   * retirement, because an inert migration that quietly came back to life would reuse audio across a
   * config change nobody proved to be waveform-neutral.
   */
  it('no longer honors the spent #91 migration under the current pinned config', async () => {
    const predecessorRuntime = {
      ...RUNTIME_IDENTITY,
      workerSha256: PREDECESSOR_WORKER_SHA256,
    }
    const { config, plan: predecessor, directory } = await renderOnce(predecessorRuntime)
    expect(
      config.sha256,
      'the live config must have moved off the migration successor, or this test proves nothing',
    ).not.toBe(AFFINE_WAV_GATE_REUSE_MIGRATION.successorProductionConfigSha256)

    const manifest = JSON.parse(await readFile(predecessor.manifestPath, 'utf8')) as {
      observedProductionConfigSha256: string
    }
    manifest.observedProductionConfigSha256 = PREDECESSOR_CONFIG_SHA256
    await writeFile(predecessor.manifestPath, `${canonicalJson(manifest)}\n`)
    const successor = createSegmentPlan(1, REQUEST, join(directory, 'audio'), config, {
      ...RUNTIME_IDENTITY,
      workerSha256: SUCCESSOR_WORKER_SHA256,
    })

    expect(predecessor.identitySha256).not.toBe(successor.identitySha256)
    // Every migration precondition but the config hash still holds, so this asserts the config hash
    // alone closes the bridge.
    expect(await tryReuse(successor, config)).toBeUndefined()
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

  it('refuses cached bytes that are not canonical audio even when the manifest agrees with them', async () => {
    const { config, plan } = await renderOnce()
    // Everything a manifest can assert about these bytes is made true: they are exactly the file
    // on disk, the length matches, and frames/duration are self-consistent for 16-bit mono PCM.
    // Only the bytes themselves are not a WAV. Reuse must still refuse them.
    const forged = Buffer.alloc(2_000, 0x58)
    await writeFile(plan.wavPath, forged)
    const frames = (forged.length - 44) / 2
    const manifest = JSON.parse(await readFile(plan.manifestPath, 'utf8')) as {
      audio: Record<string, unknown>
    }
    manifest.audio = {
      ...manifest.audio,
      sha256: sha256(forged),
      bytes: forged.length,
      frames,
      durationSeconds: frames / 24_000,
    }
    await writeFile(plan.manifestPath, `${canonicalJson(manifest)}\n`)

    expect(await tryReuse(plan, config)).toBeUndefined()
  })

  it('refuses a truncated WAV whose manifest was rewritten to match it', async () => {
    const { config, plan } = await renderOnce()
    // Header intact, payload cut: the RIFF/data length fields no longer describe the file.
    const truncated = canonicalWav(REQUEST.text).subarray(0, 1_044)
    await writeFile(plan.wavPath, truncated)
    const frames = (truncated.length - 44) / 2
    const manifest = JSON.parse(await readFile(plan.manifestPath, 'utf8')) as {
      audio: Record<string, unknown>
    }
    manifest.audio = {
      ...manifest.audio,
      sha256: sha256(truncated),
      bytes: truncated.length,
      frames,
      durationSeconds: frames / 24_000,
    }
    await writeFile(plan.manifestPath, `${canonicalJson(manifest)}\n`)

    expect(await tryReuse(plan, config)).toBeUndefined()
  })

  it('derives the returned audio shape from the file header rather than the manifest', async () => {
    const { config, plan } = await renderOnce()
    const reused = await tryReuse(plan, config)
    const header = readCanonicalWavHeader(canonicalWav(REQUEST.text), config.value.wav)
    if (typeof header === 'string') throw new Error(header)

    expect(reused?.audio.frames).toBe(header.frames)
    expect(reused?.audio.durationSeconds).toBe(header.durationSeconds)
    expect(reused?.audio.sampleRateHz).toBe(header.sampleRateHz)
  })

  it('surfaces an unreadable cache directory instead of silently rerendering', async () => {
    const { config, plan, directory } = await renderOnce()
    const output = join(directory, 'audio')
    // lstat needs traverse permission on the directory, so this is the path a file-level chmod
    // cannot reach: without ENOENT-only handling it degrades to "stale, rerender everything".
    await chmod(output, 0o000)
    try {
      const error = (await tryReuse(plan, config).then(
        () => undefined,
        (thrown: unknown) => thrown,
      )) as SpeechEngineError | undefined
      expect(error?.code).toBe('audio-validation')
      expect(error?.message).toContain('Cannot read cached render manifest')
    } finally {
      await chmod(output, 0o700)
    }
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
