import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SELECTED_GEMMA_PROFILE } from '@light-novel-audiobook/gemma-director'
import { resolveDefaultModelSnapshotPath } from '@light-novel-audiobook/pipeline-driver'
import { describe, expect, it, vi } from 'vitest'
import {
  DIRECTOR_MODE_ENV_VAR,
  DIRECTOR_URL_ENV_VAR,
  GPU_LOCK_ENV_VAR,
  LLAMA_RUNTIME_ROOT_ENV_VAR,
  QWEN_PYTHON_ENV_VAR,
  QWEN_RUNTIME_MANIFEST_ENV_VAR,
  QWEN_SNAPSHOT_ENV_VAR,
  QWEN_WORKER_ENV_VAR,
  resolveDirectorMode,
  resolveEnvironmentCompositionOptions,
  resolveRealQwenTransportConfig,
  resolveRealTransportConfig,
  resolveTransportMode,
  TRANSPORT_MODE_ENV_VAR,
} from '../src/server/environment-composition.js'
import { WebApiError } from '../src/server/errors.js'

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

const caught = (run: () => unknown): unknown => {
  try {
    run()
  } catch (error) {
    return error
  }
  return undefined
}

const caughtAsync = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run()
  } catch (error) {
    return error
  }
  return undefined
}

const expectConfigError = (error: unknown, variable: string): void => {
  expect(error).toBeInstanceOf(WebApiError)
  expect((error as WebApiError).code).toBe('internal')
  expect((error as WebApiError).message).toContain(variable)
}

/**
 * The mode switch is the CI-safety boundary of #21: `LNA_WEB_TRANSPORTS` absent MUST mean fakes,
 * and real mode must fail loudly at startup when its pinned runtime paths are not configured.
 */
describe('transport mode selection', () => {
  it('defaults to fake when the variable is absent or blank', () => {
    expect(resolveTransportMode({})).toBe('fake')
    expect(resolveTransportMode({ [TRANSPORT_MODE_ENV_VAR]: '  ' })).toBe('fake')
  })

  it('accepts fake and real explicitly', () => {
    expect(resolveTransportMode({ [TRANSPORT_MODE_ENV_VAR]: 'fake' })).toBe('fake')
    expect(resolveTransportMode({ [TRANSPORT_MODE_ENV_VAR]: 'real' })).toBe('real')
  })

  it('refuses an unrecognised value instead of guessing', () => {
    expectConfigError(
      caught(() => resolveTransportMode({ [TRANSPORT_MODE_ENV_VAR]: 'production' })),
      TRANSPORT_MODE_ENV_VAR,
    )
  })

  it('resolves to the empty options object in fake mode, leaving every default untouched', async () => {
    // No reviewer, no workspace override, no Qwen config override: if this resolved anything but
    // the empty object, the fake defaults the existing tests pin would no longer be the defaults.
    await expect(resolveEnvironmentCompositionOptions({})).resolves.toEqual({})
  })
})

describe('director mode selection', () => {
  it('preserves local Gemma as the default and accepts explicit cloud mode', () => {
    expect(resolveDirectorMode({})).toBe('local-gemma')
    expect(resolveDirectorMode({ [DIRECTOR_MODE_ENV_VAR]: 'local-gemma' })).toBe('local-gemma')
    expect(resolveDirectorMode({ [DIRECTOR_MODE_ENV_VAR]: 'openai-cloud' })).toBe('openai-cloud')
  })

  it('refuses an unknown director mode', () => {
    expectConfigError(
      caught(() => resolveDirectorMode({ [DIRECTOR_MODE_ENV_VAR]: 'automatic' })),
      DIRECTOR_MODE_ENV_VAR,
    )
  })
})

describe('real transport configuration', () => {
  const completeEnv: NodeJS.ProcessEnv = {
    [DIRECTOR_URL_ENV_VAR]: 'http://127.0.0.1:8080/v1',
    [QWEN_PYTHON_ENV_VAR]: '/runtimes/tts/bin/python',
    [QWEN_WORKER_ENV_VAR]: '/repo/packages/qwen-tts/python/qwen_batch_worker.py',
    [QWEN_RUNTIME_MANIFEST_ENV_VAR]: '/runtimes/tts/manifest.json',
    [GPU_LOCK_ENV_VAR]: '/gpu/exclusive.lock',
  }

  it('resolves the local Qwen/GPU transport without any llama configuration', async () => {
    const { [DIRECTOR_URL_ENV_VAR]: _directorUrl, ...qwenOnly } = completeEnv
    const config = await resolveRealQwenTransportConfig(qwenOnly, REPOSITORY_ROOT)
    expect(config).toEqual({
      pythonExecutable: '/runtimes/tts/bin/python',
      workerScriptPath: '/repo/packages/qwen-tts/python/qwen_batch_worker.py',
      runtimeManifestPath: '/runtimes/tts/manifest.json',
      modelSnapshotPath: await resolveDefaultModelSnapshotPath(REPOSITORY_ROOT),
      gpuLockFilePath: '/gpu/exclusive.lock',
    })
  })

  it('requires the director URL first for historical local mode', async () => {
    expectConfigError(
      await caughtAsync(() => resolveRealTransportConfig({}, REPOSITORY_ROOT)),
      DIRECTOR_URL_ENV_VAR,
    )
  })

  it('names the first missing variable rather than failing later on a half-built config', async () => {
    expectConfigError(
      await caughtAsync(() =>
        resolveRealTransportConfig(
          { [DIRECTOR_URL_ENV_VAR]: 'http://127.0.0.1:8080/v1' },
          REPOSITORY_ROOT,
        ),
      ),
      QWEN_PYTHON_ENV_VAR,
    )
  })

  it('passes every supplied value through and derives the two conventional defaults', async () => {
    const config = await resolveRealTransportConfig(completeEnv, REPOSITORY_ROOT, '/workspace')

    expect(config).toEqual({
      directorBaseUrl: 'http://127.0.0.1:8080/v1',
      // Same defaults as the pipeline driver's real mode: the pinned profile's runtime root, and
      // the snapshot directory derived from the model lock rather than restated.
      llamaRuntimeRoot: SELECTED_GEMMA_PROFILE.defaultRuntimeRoot,
      pythonExecutable: '/runtimes/tts/bin/python',
      workerScriptPath: '/repo/packages/qwen-tts/python/qwen_batch_worker.py',
      runtimeManifestPath: '/runtimes/tts/manifest.json',
      modelSnapshotPath: await resolveDefaultModelSnapshotPath(REPOSITORY_ROOT),
      gpuLockFilePath: '/gpu/exclusive.lock',
      directorCaptureDirectory: '/workspace/diagnostics/llama-server',
    })
  })

  it('lets the two defaults be overridden explicitly', async () => {
    const config = await resolveRealTransportConfig(
      {
        ...completeEnv,
        [LLAMA_RUNTIME_ROOT_ENV_VAR]: '/elsewhere/brain',
        [QWEN_SNAPSHOT_ENV_VAR]: '/elsewhere/snapshot',
      },
      REPOSITORY_ROOT,
    )

    expect(config.llamaRuntimeRoot).toBe('/elsewhere/brain')
    expect(config.modelSnapshotPath).toBe('/elsewhere/snapshot')
  })
})

describe('the server entry point', () => {
  it('rejects at startup on an invalid mode instead of starting on guessed adapters', async () => {
    vi.stubEnv(TRANSPORT_MODE_ENV_VAR, 'bogus')
    vi.resetModules()
    try {
      const { getAudiobookWebApi } = await import('../src/server/composition-root.js')
      const error = await getAudiobookWebApi().then(
        () => undefined,
        (caughtError: unknown) => caughtError,
      )
      // resetModules gives the re-imported module graph its own WebApiError class, so assert on
      // the shape, not instanceof.
      const failure = error as { name?: string; code?: string; message?: string }
      expect(failure.name).toBe('WebApiError')
      expect(failure.code).toBe('internal')
      expect(failure.message).toContain(TRANSPORT_MODE_ENV_VAR)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('builds the fake composition when the mode variable is absent', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lna-web-env-fake-'))
    vi.stubEnv('AUDIOBOOK_WORKSPACE_DIR', root)
    vi.stubEnv('LNA_REVIEWER', 'env-fake-test')
    vi.resetModules()
    try {
      const { getAudiobookWebApi } = await import('../src/server/composition-root.js')
      const api = await getAudiobookWebApi()
      // The in-memory default: nothing persisted, no GPU, no model weights touched.
      await expect(api.getJobState({ jobId: 'job-not-anywhere' })).resolves.toBeNull()
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })
})
