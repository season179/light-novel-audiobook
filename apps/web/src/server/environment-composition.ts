import path from 'node:path'
import { SELECTED_GEMMA_PROFILE } from '@light-novel-audiobook/gemma-director'
import {
  createRealTransports,
  type RealTransportConfig,
  resolveDefaultModelSnapshotPath,
} from '@light-novel-audiobook/pipeline-driver'
import type { AudiobookWebApiOptions } from './composition-root.js'
import { WebApiError } from './errors.js'
import {
  createM1VoiceCast,
  findRepositoryRoot,
  loadPinnedQwenConfig,
  M1_CHARACTER_SPEAKER_IDS,
  QWEN_PRODUCTION_CONFIG_ENV_VAR,
} from './m1-voice-cast.js'
import { createRealAdapterFactories } from './real-adapter-factories.js'
import { createWorkspace, resolveWorkspaceRoot, WORKSPACE_ENV_VAR } from './workspace.js'

/**
 * Which adapters the server composes, selected by explicit configuration. Mirrors the pipeline
 * driver's `--transports fake|real`: **fake is the default** because CI has no GPU, no model
 * weights, and no ffmpeg guarantees beyond the pinned toolchain, and a default that loads Gemma
 * breaks every test in the repo. Real adapters exist only when this variable says so.
 */
export const TRANSPORT_MODE_ENV_VAR = 'LNA_WEB_TRANSPORTS'

export const DIRECTOR_URL_ENV_VAR = 'LNA_DIRECTOR_URL'
export const LLAMA_RUNTIME_ROOT_ENV_VAR = 'LNA_LLAMA_RUNTIME_ROOT'
export const QWEN_PYTHON_ENV_VAR = 'LNA_QWEN_PYTHON'
export const QWEN_WORKER_ENV_VAR = 'LNA_QWEN_WORKER'
export const QWEN_RUNTIME_MANIFEST_ENV_VAR = 'LNA_QWEN_RUNTIME_MANIFEST'
export const QWEN_SNAPSHOT_ENV_VAR = 'LNA_QWEN_SNAPSHOT'
export const GPU_LOCK_ENV_VAR = 'LNA_GPU_LOCK'

export type TransportMode = 'fake' | 'real'

export const resolveTransportMode = (env: NodeJS.ProcessEnv): TransportMode => {
  const raw = env[TRANSPORT_MODE_ENV_VAR]
  if (raw === undefined || raw.trim().length === 0) return 'fake'
  if (raw === 'fake' || raw === 'real') return raw
  throw new WebApiError(
    'internal',
    `${TRANSPORT_MODE_ENV_VAR} must be 'fake' or 'real', got ${JSON.stringify(raw)}`,
  )
}

const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]
  if (value === undefined || value.trim().length === 0) {
    throw new WebApiError(
      'internal',
      `${TRANSPORT_MODE_ENV_VAR}=real requires ${name} to be set; see apps/web/README.md`,
    )
  }
  return value
}

/**
 * The real-transport configuration, with the same shape and defaults as the pipeline driver's real
 * mode: everything locates a pinned runtime, and the two paths the driver leaves to convention
 * (the llama.cpp runtime root, the Qwen snapshot) default exactly as `--transports real` does.
 */
export const resolveRealTransportConfig = async (
  env: NodeJS.ProcessEnv,
  repositoryRoot: string,
  workspaceRoot = resolveWorkspaceRoot(env[WORKSPACE_ENV_VAR]),
): Promise<RealTransportConfig> => ({
  directorBaseUrl: required(env, DIRECTOR_URL_ENV_VAR),
  llamaRuntimeRoot: env[LLAMA_RUNTIME_ROOT_ENV_VAR] ?? SELECTED_GEMMA_PROFILE.defaultRuntimeRoot,
  pythonExecutable: required(env, QWEN_PYTHON_ENV_VAR),
  workerScriptPath: required(env, QWEN_WORKER_ENV_VAR),
  runtimeManifestPath: required(env, QWEN_RUNTIME_MANIFEST_ENV_VAR),
  modelSnapshotPath:
    env[QWEN_SNAPSHOT_ENV_VAR] ?? (await resolveDefaultModelSnapshotPath(repositoryRoot)),
  gpuLockFilePath: required(env, GPU_LOCK_ENV_VAR),
  directorCaptureDirectory: path.join(workspaceRoot, 'diagnostics', 'llama-server'),
})

/**
 * The composition options for the configured mode. Returns a value rather than an API so this
 * module never imports the composition root at runtime: `composition-root.ts` calls this from
 * `getAudiobookWebApi`, and an import cycle at module scope would be load-order fragile.
 *
 * Fake mode returns the empty options object — every default in `createAudiobookWebApi` stays
 * exactly what the existing tests pin. Real mode opens the shared SQLite workspace, builds the
 * real transports (which asserts the pinned llama-server binary, Gemma model file and Qwen snapshot
 * before anything loads), and supplies one factory per adapter field.
 */
export const resolveEnvironmentCompositionOptions = async (
  env: NodeJS.ProcessEnv = process.env,
): Promise<AudiobookWebApiOptions> => {
  const mode = resolveTransportMode(env)
  if (mode === 'fake') return {}

  const repositoryRoot = findRepositoryRoot(process.cwd())
  if (repositoryRoot === undefined) {
    throw new WebApiError(
      'internal',
      `${TRANSPORT_MODE_ENV_VAR}=real must run from inside the repository so the pinned ` +
        'Qwen configuration and worker runtime can be located',
    )
  }
  const workspace = await createWorkspace(resolveWorkspaceRoot(env[WORKSPACE_ENV_VAR]))
  const voices = createM1VoiceCast(await loadPinnedQwenConfig(env[QWEN_PRODUCTION_CONFIG_ENV_VAR]))
  const shutdownController = new AbortController()
  const transports = await createRealTransports(
    await resolveRealTransportConfig(env, repositoryRoot, workspace.root),
  )
  const realAdapters = await createRealAdapterFactories({
    workspace,
    repositoryRoot,
    transports,
    characterSpeakerIds: M1_CHARACTER_SPEAKER_IDS,
    narratorProfileId: voices.narrator.id,
    fallbackProfileId: voices.fallback.id,
    shutdownSignal: shutdownController.signal,
  })
  return {
    workspace,
    voices,
    ...realAdapters.factories,
    runtimeShutdown: {
      controller: shutdownController,
      releaseOwnedResources: transports.close,
      closeResources: realAdapters.close,
    },
  }
}
