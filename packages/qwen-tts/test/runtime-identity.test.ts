import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadProductionConfig } from '../src/config.js'
import {
  AFFINE_WAV_GATE_REUSE_MIGRATION,
  loadWorkerRuntimeIdentity,
  type QwenWorkerRuntimeIdentity,
  waveformProducingRuntimeIdentity,
} from '../src/runtime-identity.js'
import { SpeechEngineError } from '../src/types.js'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PRODUCTION_CONFIG = join(PACKAGE_ROOT, '../../config/qwen3-tts-production.json')
const UV_LOCK = join(PACKAGE_ROOT, '../../scripts/qwen3-tts-runtime/uv.lock')

/**
 * The package pair that DISTINGUISHES the two comparators and is the real-world trigger for #59.
 * '-' is U+002D (45) and '_' is U+005F (95), so by Unicode code point
 *   'typing-inspection' < 'typing_extensions'   (hyphen sorts first).
 * But on this Node (full ICU, default locale)
 *   'typing-inspection'.localeCompare('typing_extensions') === 1
 * i.e. localeCompare sorts 'typing_extensions' FIRST -- the opposite. A canonical-form check built
 * on localeCompare therefore rejects a manifest that is correctly canonical under code point order,
 * which is exactly what the runtime manifest generator (scripts/qwen3-tts-extension.sh) produces.
 * A test with only alphabetic names would pass under either comparator and prove nothing.
 */
const HYBRID = [
  { name: 'typing-inspection', version: '0.4.1' },
  { name: 'typing_extensions', version: '4.14.0' },
] as const

/** The pinned imports loadWorkerRuntimeIdentity requires to be present at the locked versions. */
const PINNED = [
  { name: 'qwen-tts', version: '0.1.1' },
  { name: 'torch', version: '2.9.1' },
  { name: 'torchaudio', version: '2.9.1' },
] as const

/** A plain code-point comparator (the deterministic order the generator uses). */
function byCodePoint(left: { name: string }, right: { name: string }): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

interface ManifestInput {
  readonly packages: ReadonlyArray<{ name: string; version: string }>
}

async function withLoadedIdentity(
  manifest: ManifestInput,
): ReturnType<typeof loadWorkerRuntimeIdentity> {
  const production = await loadProductionConfig(PRODUCTION_CONFIG)
  const uvLockBytes = await import('node:fs/promises').then(({ readFile }) => readFile(UV_LOCK))
  const dir = await mkdtemp(join(tmpdir(), 'qwen-runtime-id-'))
  const runtimeManifestPath = join(dir, 'manifest.json')
  await writeFile(
    runtimeManifestPath,
    `${JSON.stringify({
      schemaVersion: 1,
      immutable: true,
      pythonVersion: production.value.runtime.python,
      // Must equal the config-pinned uv lock hash, which must equal sha256(the real uv.lock).
      uvLockSha256: createHash('sha256').update(uvLockBytes).digest('hex'),
      packages: manifest.packages,
    })}\n`,
    'utf8',
  )
  // worker and python are only hashed (never validated against a pinned hash), so any bytes do.
  const workerScriptPath = join(dir, 'worker.py')
  const pythonExecutable = join(dir, 'python')
  await writeFile(workerScriptPath, '# worker bytes\n')
  await writeFile(pythonExecutable, 'python bytes\n')
  return loadWorkerRuntimeIdentity(
    { workerScriptPath, pythonExecutable, runtimeManifestPath, uvLockPath: UV_LOCK },
    production,
  )
}

describe('gate-only worker identity migration (#91)', () => {
  const runtime = (workerSha256: string): QwenWorkerRuntimeIdentity => ({
    workerSha256,
    pythonExecutableSha256: '1'.repeat(64),
    runtimeManifestSha256: '2'.repeat(64),
    uvLockSha256: '3'.repeat(64),
    installedPackagesSha256: '4'.repeat(64),
    imports: { qwenTts: '0.1.1', torch: '2.9.1', torchaudio: '2.9.1' },
  })

  it('normalizes only the exact affine-gate successor to the predecessor waveform identity', () => {
    const migration = AFFINE_WAV_GATE_REUSE_MIGRATION
    expect(
      waveformProducingRuntimeIdentity(runtime(migration.successorWorkerSha256)).workerSha256,
    ).toBe(migration.predecessorWorkerSha256)
    const future = runtime('f'.repeat(64))
    expect(waveformProducingRuntimeIdentity(future)).toBe(future)
  })
})

describe('loadWorkerRuntimeIdentity package ordering (#59)', () => {
  it('accepts a code-point-canonical manifest that localeCompare would reject', async () => {
    // Code-point order: qwen-tts, torch, torchaudio, typing-inspection, typing_extensions.
    // localeCompare would reorder only the last two (typing_extensions before typing-inspection),
    // so the localeCompare checker rejects this exact manifest even though it is canonical.
    const packages = [...PINNED, ...HYBRID].sort(byCodePoint)
    const identity = await withLoadedIdentity({ packages })
    expect(identity.imports).toEqual({ qwenTts: '0.1.1', torch: '2.9.1', torchaudio: '2.9.1' })
    // installedPackagesSha256 is the code-point-canonical inventory hash; it must be deterministic.
    expect(identity.installedPackagesSha256).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('still rejects a package inventory that is not in code-point order', async () => {
    // 'torch' before 'qwen-tts' is out of order under code point (and under localeCompare too):
    // the fix must keep rejecting genuinely non-canonical inventories, not just change the rule.
    const packages = [
      { name: 'torch', version: '2.9.1' },
      { name: 'qwen-tts', version: '0.1.1' },
      { name: 'torchaudio', version: '2.9.1' },
      ...HYBRID,
    ]
    await expect(withLoadedIdentity({ packages })).rejects.toMatchObject({
      name: 'SpeechEngineError',
      code: 'configuration',
      message: expect.stringContaining('runtime package inventory is not canonical'),
    })
    await expect(withLoadedIdentity({ packages })).rejects.toBeInstanceOf(SpeechEngineError)
  })
})
