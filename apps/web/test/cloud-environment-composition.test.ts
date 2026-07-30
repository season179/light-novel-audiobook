import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { DirectorModel } from '@light-novel-audiobook/application'
import { FileGpuLeaseCoordinator } from '@light-novel-audiobook/gpu-lease'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DIRECTOR_MODE_ENV_VAR,
  DIRECTOR_URL_ENV_VAR,
  GPU_LOCK_ENV_VAR,
  LLAMA_RUNTIME_ROOT_ENV_VAR,
  OPENAI_API_KEY_ENV_VAR,
  QWEN_PYTHON_ENV_VAR,
  QWEN_RUNTIME_MANIFEST_ENV_VAR,
  QWEN_SNAPSHOT_ENV_VAR,
  QWEN_WORKER_ENV_VAR,
  resolveEnvironmentCompositionOptions,
  TRANSPORT_MODE_ENV_VAR,
} from '../src/server/environment-composition.js'
import type {
  DirectorFactoryBinding,
  RealAdapterFactoryOptions,
} from '../src/server/real-adapter-factories.js'
import { WORKSPACE_ENV_VAR } from '../src/server/workspace.js'

const capture = vi.hoisted(() => ({
  adapterOptions: [] as unknown[],
  localTransportCalls: 0,
  closeCalls: 0,
}))

vi.mock('@light-novel-audiobook/pipeline-driver', async (importOriginal) => {
  const original = await importOriginal<typeof import('@light-novel-audiobook/pipeline-driver')>()
  return {
    ...original,
    createRealTransports: async () => {
      capture.localTransportCalls += 1
      throw new Error('Cloud mode must not construct local llama transports')
    },
  }
})

vi.mock('../src/server/real-adapter-factories.js', () => ({
  createRealAdapterFactories: async (options: RealAdapterFactoryOptions) => {
    capture.adapterOptions.push(options)
    const director = options.director as DirectorFactoryBinding
    return {
      factories: {
        directorIdentity: director.identity,
        createDirectorModel: () => director.create(),
      },
      close: () => {
        capture.closeCalls += 1
      },
    }
  },
}))

const roots: string[] = []

afterEach(async () => {
  capture.adapterOptions.length = 0
  capture.localTransportCalls = 0
  capture.closeCalls = 0
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('OpenAI cloud environment composition', () => {
  it('composes cloud direction with local Qwen/GPU and no llama URL, runtime, or model file', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lna-web-cloud-env-'))
    roots.push(root)
    const env: NodeJS.ProcessEnv = {
      [TRANSPORT_MODE_ENV_VAR]: 'real',
      [DIRECTOR_MODE_ENV_VAR]: 'openai-cloud',
      [OPENAI_API_KEY_ENV_VAR]: 'server-only-cloud-key-113',
      [WORKSPACE_ENV_VAR]: root,
      [QWEN_PYTHON_ENV_VAR]: '/qwen/runtime/bin/python',
      [QWEN_WORKER_ENV_VAR]: '/repo/packages/qwen-tts/python/qwen_batch_worker.py',
      [QWEN_RUNTIME_MANIFEST_ENV_VAR]: '/qwen/runtime/manifest.json',
      [QWEN_SNAPSHOT_ENV_VAR]: '/qwen/model/snapshot',
      [GPU_LOCK_ENV_VAR]: path.join(root, 'gpu', 'exclusive.lock'),
    }

    expect(env[DIRECTOR_URL_ENV_VAR]).toBeUndefined()
    expect(env[LLAMA_RUNTIME_ROOT_ENV_VAR]).toBeUndefined()
    const options = await resolveEnvironmentCompositionOptions(env)

    expect(capture.localTransportCalls).toBe(0)
    expect(capture.adapterOptions).toHaveLength(1)
    const wired = capture.adapterOptions[0] as RealAdapterFactoryOptions
    expect(wired.transports.director).toBeUndefined()
    expect(wired.transports.speech).toEqual({
      pythonExecutable: '/qwen/runtime/bin/python',
      workerScriptPath: '/repo/packages/qwen-tts/python/qwen_batch_worker.py',
      runtimeManifestPath: '/qwen/runtime/manifest.json',
      modelSnapshotPath: '/qwen/model/snapshot',
      processEnvironment: {},
    })
    expect(wired.transports.gpu.lockFilePath).toBe(path.join(root, 'gpu', 'exclusive.lock'))
    expect(wired.transports.gpu.coordinator).toBeInstanceOf(FileGpuLeaseCoordinator)

    const director = (await options.createDirectorModel?.()) as DirectorModel
    expect(director.identity).toBe(options.directorIdentity)
    expect(JSON.stringify({ identity: director.identity })).not.toContain(
      env[OPENAI_API_KEY_ENV_VAR] as string,
    )
    await director.release()
    await options.runtimeShutdown?.releaseOwnedResources?.()
    await options.runtimeShutdown?.closeResources?.()
    expect(capture.closeCalls).toBe(1)
  })

  it('requires the server-only key by variable name without echoing any value', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lna-web-cloud-env-'))
    roots.push(root)
    const error = await resolveEnvironmentCompositionOptions({
      [TRANSPORT_MODE_ENV_VAR]: 'real',
      [DIRECTOR_MODE_ENV_VAR]: 'openai-cloud',
      [WORKSPACE_ENV_VAR]: root,
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(OPENAI_API_KEY_ENV_VAR)
    expect((error as Error).message).not.toContain('server-only-cloud-key-113')
  })
})
