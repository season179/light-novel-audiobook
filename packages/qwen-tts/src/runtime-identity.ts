import { readFile } from 'node:fs/promises'
import type { LoadedProductionConfig } from './config.js'
import { canonicalJson, sha256 } from './manifest.js'
import { SpeechEngineError } from './types.js'

interface RuntimePackage {
  readonly name: string
  readonly version: string
}

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
  const sorted = [...packages].sort((left, right) => left.name.localeCompare(right.name))
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
