import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SELECTED_GEMMA_PROFILE } from '@light-novel-audiobook/gemma-director'
import { resolveDefaultModelSnapshotPath } from '@light-novel-audiobook/pipeline-driver'
import { describe, expect, it } from 'vitest'
import {
  DIRECTOR_URL_ENV_VAR,
  GPU_LOCK_ENV_VAR,
  LLAMA_RUNTIME_ROOT_ENV_VAR,
  QWEN_PYTHON_ENV_VAR,
  QWEN_RUNTIME_MANIFEST_ENV_VAR,
  QWEN_SNAPSHOT_ENV_VAR,
  QWEN_WORKER_ENV_VAR,
  resolveEnvironmentCompositionOptions,
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

describe('real transport configuration', () => {
  const completeEnv: NodeJS.ProcessEnv = {
    [DIRECTOR_URL_ENV_VAR]: 'http://127.0.0.1:8080/v1',
    [QWEN_PYTHON_ENV_VAR]: '/runtimes/tts/bin/python',
    [QWEN_WORKER_ENV_VAR]: '/repo/packages/qwen-tts/python/qwen_batch_worker.py',
    [QWEN_RUNTIME_MANIFEST_ENV_VAR]: '/runtimes/tts/manifest.json',
    [GPU_LOCK_ENV_VAR]: '/gpu/exclusive.lock',
  }

  it('requires the director URL first', async () => {
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
    const config = await resolveRealTransportConfig(completeEnv, REPOSITORY_ROOT)

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
