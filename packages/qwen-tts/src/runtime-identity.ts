import { readFile } from 'node:fs/promises'
import type { LoadedProductionConfig } from './config.js'
import { canonicalJson, sha256 } from './manifest.js'
import { SpeechEngineError } from './types.js'

interface RuntimePackage {
  readonly name: string
  readonly version: string
}

export const AFFINE_WAV_GATE_REUSE_MIGRATION = Object.freeze({
  predecessorProductionConfigSha256:
    '82f9a62a94a62bcf68e5d35709e358ffb552e380d1295a8e7b014dc82a219f25',
  predecessorWorkerSha256: '966d089fc0a65d63bcdd6a3d99f6baebd32e93bf054d0d67aa6f2b4050f02ca7',
  successorProductionConfigSha256:
    'd830eec3a9a3c46b3955a3fa0b6975d35b24ad1389f7c7d29547fffc2f7214b1',
  successorWorkerSha256: '9736166166ecf73cef3506f6cfa9e80e16eeb9bd5e532bc032fad54b0440d113',
})

export interface QwenWorkerRuntimeIdentity {
  readonly workerSha256: string
  readonly pythonExecutableSha256: string
  readonly runtimeManifestSha256: string
  readonly uvLockSha256: string
  readonly installedPackagesSha256: string
  readonly imports: {
    readonly qwenTts: string
    readonly torch: string
    readonly torchaudio: string
  }
}

export function waveformProducingRuntimeIdentity(
  identity: QwenWorkerRuntimeIdentity,
): QwenWorkerRuntimeIdentity {
  // #91 changed only the post-generation health validator in the pinned worker. Preserve the
  // predecessor's waveform-content identity for that exact successor so resumable application
  // input identities do not stale; manifests still record the actual successor hash and apply the
  // separately bounded reuse migration. Any future worker hash remains identity-invalidating.
  if (identity.workerSha256 !== AFFINE_WAV_GATE_REUSE_MIGRATION.successorWorkerSha256) {
    return identity
  }
  return Object.freeze({
    ...identity,
    workerSha256: AFFINE_WAV_GATE_REUSE_MIGRATION.predecessorWorkerSha256,
  })
}

function failure(message: string): never {
  throw new SpeechEngineError('configuration', `Pinned Qwen runtime identity failed: ${message}`)
}

export async function loadWorkerRuntimeIdentity(
  paths: {
    readonly workerScriptPath: string
    readonly pythonExecutable: string
    readonly runtimeManifestPath: string
    readonly uvLockPath: string
  },
  production: LoadedProductionConfig,
): Promise<QwenWorkerRuntimeIdentity> {
  const [worker, python, manifestBytes, uvLock] = await Promise.all([
    readFile(paths.workerScriptPath),
    readFile(paths.pythonExecutable),
    readFile(paths.runtimeManifestPath),
    readFile(paths.uvLockPath),
  ])
  if (sha256(uvLock) !== production.value.runtime.uvLockSha256) failure('uv lock hash changed')

  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8')) as Record<string, unknown>
  } catch {
    failure('runtime manifest is malformed')
  }
  if (
    manifest.schemaVersion !== 1 ||
    manifest.immutable !== true ||
    manifest.pythonVersion !== production.value.runtime.python ||
    manifest.uvLockSha256 !== production.value.runtime.uvLockSha256 ||
    !Array.isArray(manifest.packages)
  ) {
    failure('runtime manifest header changed')
  }
  const packages: RuntimePackage[] = manifest.packages.map((item) => {
    if (
      item === null ||
      typeof item !== 'object' ||
      typeof (item as Record<string, unknown>).name !== 'string' ||
      typeof (item as Record<string, unknown>).version !== 'string'
    ) {
      failure('runtime package inventory is malformed')
    }
    return item as RuntimePackage
  })
  // Compare by Unicode code point, NOT localeCompare (#59). The generator
  // (scripts/qwen3-tts-extension.sh) builds this list with Python's sorted(key=name), which is a
  // code-point order; localeCompare is locale- and ICU-dependent, so on some machines it orders the
  // same manifest differently (e.g. it puts 'typing_extensions' before 'typing-inspection' because
  // '_' sorts before '-' under the default collator, opposite to code point). A canonical-form
  // integrity check must be deterministic across environments, so it must not depend on the locale.
  const sorted = [...packages].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )
  if (canonicalJson(packages) !== canonicalJson(sorted))
    failure('runtime package inventory is not canonical')
  const byName = new Map(packages.map((item) => [item.name, item.version]))
  if (
    byName.get('qwen-tts') !== production.value.runtime.version ||
    byName.get('torch') !== production.value.runtime.torch ||
    byName.get('torchaudio') !== production.value.runtime.torchaudio ||
    byName.has('flash-attn')
  ) {
    failure('pinned imports do not match the runtime manifest')
  }

  return Object.freeze({
    workerSha256: sha256(worker),
    pythonExecutableSha256: sha256(python),
    runtimeManifestSha256: sha256(manifestBytes),
    uvLockSha256: sha256(uvLock),
    installedPackagesSha256: sha256(canonicalJson(packages)),
    imports: Object.freeze({
      qwenTts: production.value.runtime.version,
      torch: production.value.runtime.torch,
      torchaudio: production.value.runtime.torchaudio,
    }),
  })
}
