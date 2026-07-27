import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  defaultFfmpegDirectory,
  FFMPEG_DIRECTORY_ENV,
  FfmpegAudioAssembler,
} from '@light-novel-audiobook/audio-assembly'
import { AudiobookJob } from '@light-novel-audiobook/domain'
import { DomainEpubExtractor } from '@light-novel-audiobook/epub-ingestion'
import {
  layoutFor,
  migrateSchema,
  openWorkspace,
  SqliteFallbackApprovalRepository,
  SqliteJobRepository,
} from '@light-novel-audiobook/persistence'
import type { RealTransportConfig } from '@light-novel-audiobook/pipeline-driver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDirectorContentIdentity } from '../src/server/director-content-identity.js'
import {
  DIRECTOR_URL_ENV_VAR,
  GPU_LOCK_ENV_VAR,
  QWEN_PYTHON_ENV_VAR,
  QWEN_RUNTIME_MANIFEST_ENV_VAR,
  QWEN_SNAPSHOT_ENV_VAR,
  QWEN_WORKER_ENV_VAR,
  resolveEnvironmentCompositionOptions,
  TRANSPORT_MODE_ENV_VAR,
} from '../src/server/environment-composition.js'
import { FAKE_DIRECTOR_IDENTITY } from '../src/server/fakes/fake-director-model.js'
import { WORKSPACE_ENV_VAR } from '../src/server/workspace.js'

/**
 * The seam the #21 review found unpinned: `LNA_WEB_TRANSPORTS=real` builds real resources, and the
 * resolver must hand the real factory set to `createAudiobookWebApi`. Dropping `...factories` from
 * the returned options left every existing test green while the server silently fell back to its
 * fake defaults. These tests select real mode through the environment/server entry point — never
 * by calling `createRealAdapterFactories` directly — and prove the API options contain and use the
 * real set.
 *
 * The only mocked seam is `createRealTransports`, the GPU-adjacent step that asserts the pinned
 * llama-server binary, Gemma model file and Qwen snapshot. Everything behind it — the real
 * factories, the real SQLite persistence boundary, the real assembler — genuinely runs.
 */
const handoff = vi.hoisted(() => ({
  transportCalls: [] as RealTransportConfig[],
  runtimeDirs: [] as string[],
}))

vi.mock('@light-novel-audiobook/pipeline-driver', async (importOriginal) => {
  const original = await importOriginal<typeof import('@light-novel-audiobook/pipeline-driver')>()
  const fsPromises = await import('node:fs/promises')
  const nodeFs = await import('node:fs')
  const nodeOs = await import('node:os')
  const nodePath = await import('node:path')

  const repositoryRoot = (() => {
    let current = process.cwd()
    for (;;) {
      if (nodeFs.existsSync(nodePath.join(current, 'pnpm-workspace.yaml'))) return current
      const parent = nodePath.parse(current).dir
      if (parent === current) throw new Error('repository root not found from test process')
      current = parent
    }
  })()

  return {
    ...original,
    // Fake transports stand in for the owned llama.cpp runtime, exactly as the pipeline driver's
    // own fake mode does: no GPU, no model weights, no network beyond loopback. The resolved
    // real-mode configuration is recorded so the test can prove the environment drove it.
    createRealTransports: async (config: RealTransportConfig) => {
      handoff.transportCalls.push(config)
      const runtimeDirectory = await fsPromises.mkdtemp(
        nodePath.join(nodeOs.tmpdir(), 'lna-web-real-handoff-rt-'),
      )
      handoff.runtimeDirs.push(runtimeDirectory)
      return original.createFakeTransports(
        { runtimeDirectory, repositoryRoot },
        config.directorBaseUrl,
      )
    },
  }
})

// `createRealAdapterFactories` always builds the pinned-toolchain FFmpeg assembler, so this suite
// follows the factory tests' pattern: announce a loud skip rather than vanish quietly.
const TOOLCHAIN_DIRECTORY = path.resolve(
  process.env[FFMPEG_DIRECTORY_ENV] ?? defaultFfmpegDirectory(),
)
const TOOLCHAIN_PRESENT =
  existsSync(path.join(TOOLCHAIN_DIRECTORY, 'ffmpeg')) &&
  existsSync(path.join(TOOLCHAIN_DIRECTORY, 'ffprobe'))
if (!TOOLCHAIN_PRESENT) {
  process.stderr.write(
    `[skipped] web real-environment handoff coverage did not run: pinned ffmpeg/ffprobe not found in ${TOOLCHAIN_DIRECTORY}.\n`,
  )
}

const DIRECTOR_BASE_URL = 'http://127.0.0.1:18099/v1'

const realModeEnv = (workspaceRoot: string): NodeJS.ProcessEnv => ({
  [TRANSPORT_MODE_ENV_VAR]: 'real',
  [WORKSPACE_ENV_VAR]: workspaceRoot,
  LNA_REVIEWER: 'real-handoff-test',
  [DIRECTOR_URL_ENV_VAR]: DIRECTOR_BASE_URL,
  // Never resolved: the transport seam is mocked, so these only have to survive configuration
  // validation and prove the environment drove them into the transport call.
  [QWEN_PYTHON_ENV_VAR]: '/runtimes/tts/bin/python',
  [QWEN_WORKER_ENV_VAR]: '/runtimes/tts/qwen_batch_worker.py',
  [QWEN_RUNTIME_MANIFEST_ENV_VAR]: '/runtimes/tts/manifest.json',
  [QWEN_SNAPSHOT_ENV_VAR]: '/runtimes/tts/snapshot',
  [GPU_LOCK_ENV_VAR]: path.join(workspaceRoot, 'gpu.lock'),
})

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    [...roots.splice(0), ...handoff.runtimeDirs.splice(0)].map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  )
})

describe.skipIf(!TOOLCHAIN_PRESENT)('real mode selected through the environment', () => {
  it('hands the whole real factory set into the resolved composition options', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lna-web-real-handoff-'))
    roots.push(root)
    const callsBefore = handoff.transportCalls.length

    const options = await resolveEnvironmentCompositionOptions(realModeEnv(root))

    // Real mode was reached through the environment, with the configuration the variables supplied.
    expect(handoff.transportCalls.length).toBe(callsBefore + 1)
    expect(handoff.transportCalls[callsBefore]).toMatchObject({
      directorBaseUrl: DIRECTOR_BASE_URL,
      pythonExecutable: '/runtimes/tts/bin/python',
      workerScriptPath: '/runtimes/tts/qwen_batch_worker.py',
      runtimeManifestPath: '/runtimes/tts/manifest.json',
      modelSnapshotPath: '/runtimes/tts/snapshot',
      gpuLockFilePath: path.join(root, 'gpu.lock'),
      directorCaptureDirectory: path.join(root, 'diagnostics', 'llama-server'),
    })

    // Containment: every adapter field is the real set, not a fake default left behind.
    expect(options.workspace).toBeDefined()
    expect(options.voices).toBeDefined()
    expect(options.jobs).toBeInstanceOf(SqliteJobRepository)
    expect(options.approvals).toBeInstanceOf(SqliteFallbackApprovalRepository)
    expect(await options.createEpubExtractor?.()).toBeInstanceOf(DomainEpubExtractor)
    expect(await options.createAudioAssembler?.()).toBeInstanceOf(FfmpegAudioAssembler)
    expect(options.speechEngineFactory?.identity).toEqual(expect.any(String))
    const engine = await options.speechEngineFactory?.create({
      bookId: 'book-handoff',
      fallbackApprovals: [],
    })
    expect(engine?.identity).toBe(options.speechEngineFactory?.identity)

    // The director: a fresh, identity-agreeing model per call, and never the fake identity.
    expect(options.directorIdentity).toEqual(expect.any(String))
    expect(options.directorIdentity).not.toBe(FAKE_DIRECTOR_IDENTITY)
    expect(options.directorIdentity).toBe(
      createDirectorContentIdentity({
        baseUrl: DIRECTOR_BASE_URL,
        confidenceThreshold: 0.5,
        gpuLeaseLockFilePath: path.join(root, 'gpu.lock'),
      }),
    )
    const director = await options.createDirectorModel?.()
    expect(director?.identity).toBe(options.directorIdentity)
    await director?.release()
  })

  it('serves the API on the real factories when the server entry point reads real mode', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lna-web-real-handoff-'))
    roots.push(root)
    for (const [name, value] of Object.entries(realModeEnv(root))) vi.stubEnv(name, value)
    vi.resetModules()
    const callsBefore = handoff.transportCalls.length

    // The production seam itself: getAudiobookWebApi resolves the environment and composes the API.
    const { getAudiobookWebApi } = await import('../src/server/composition-root.js')
    const api = await getAudiobookWebApi()
    expect(handoff.transportCalls.length).toBe(callsBefore + 1)

    // "And use": a job written on a second, independent connection — the pipeline driver's
    // position — is visible through the API only if the API reads through the real SQLite
    // repository the factories supplied. The in-memory default the mutation falls back to
    // answers null here.
    const JOB_ID = 'job-written-by-the-driver-side'
    const layout = layoutFor(root)
    const other = openWorkspace(layout)
    try {
      migrateSchema(other)
      await new SqliteJobRepository(layout, other).saveJob(new AudiobookJob(JOB_ID))
    } finally {
      other.close()
    }

    const state = await api.getJobState({ jobId: JOB_ID })
    expect(state?.jobId).toBe(JOB_ID)
    expect(state?.state).toBe('pending')
  })
})
