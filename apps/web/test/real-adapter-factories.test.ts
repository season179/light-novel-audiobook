import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  defaultFfmpegDirectory,
  FFMPEG_DIRECTORY_ENV,
  FfmpegAudioAssembler,
} from '@light-novel-audiobook/audio-assembly'
import { AudiobookJob } from '@light-novel-audiobook/domain'
import { DomainEpubExtractor } from '@light-novel-audiobook/epub-ingestion'
import { createGemmaDirectorIdentity } from '@light-novel-audiobook/gemma-director'
import {
  layoutFor,
  openWorkspace,
  SqliteFallbackApprovalRepository,
  SqliteJobRepository,
} from '@light-novel-audiobook/persistence'
import {
  createFakeTransports,
  type PipelineTransports,
} from '@light-novel-audiobook/pipeline-driver'
import { afterEach, describe, expect, it } from 'vitest'
import { createDirectorContentIdentity } from '../src/server/director-content-identity.js'
import {
  createRealAdapterFactories,
  type RealAdapterFactories,
} from '../src/server/real-adapter-factories.js'
import { createWorkspace } from '../src/server/workspace.js'

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

// The builder always constructs the pinned-toolchain FFmpeg assembler, so the whole suite follows
// the driver tests' pattern: announce a loud skip rather than letting the coverage quietly vanish.
const TOOLCHAIN_DIRECTORY = path.resolve(
  process.env[FFMPEG_DIRECTORY_ENV] ?? defaultFfmpegDirectory(),
)
const TOOLCHAIN_PRESENT =
  existsSync(path.join(TOOLCHAIN_DIRECTORY, 'ffmpeg')) &&
  existsSync(path.join(TOOLCHAIN_DIRECTORY, 'ffprobe'))
if (!TOOLCHAIN_PRESENT) {
  process.stderr.write(
    `[skipped] web real-adapter-factory coverage did not run: pinned ffmpeg/ffprobe not found in ${TOOLCHAIN_DIRECTORY}.\n`,
  )
}

const roots: string[] = []
const built: RealAdapterFactories[] = []
const transportsToClose: PipelineTransports[] = []

afterEach(async () => {
  for (const target of built.splice(0)) target.close()
  await Promise.all(transportsToClose.splice(0).map((transports) => transports.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/**
 * Real adapters, constructed against fake transports: no GPU, no model weights, no llama-server,
 * no network beyond loopback. This is as real as construction can get without loading weights —
 * the genuine classes, the genuine SQLite persistence boundary, the genuine identity material.
 */
const buildRealFactories = async (): Promise<{
  readonly factories: RealAdapterFactories['factories']
  readonly workspaceRoot: string
  readonly transports: PipelineTransports
}> => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'lna-web-real-adapters-'))
  roots.push(workspaceRoot)
  const workspace = await createWorkspace(workspaceRoot)
  const transports = await createFakeTransports(
    {
      runtimeDirectory: path.join(workspaceRoot, 'runtime'),
      repositoryRoot: REPOSITORY_ROOT,
    },
    'http://127.0.0.1:18080/v1',
  )
  transportsToClose.push(transports)
  const result = await createRealAdapterFactories({
    workspace,
    repositoryRoot: REPOSITORY_ROOT,
    transports,
    characterSpeakerIds: ['alice'],
    narratorProfileId: 'narrator-aiden-calm',
    fallbackProfileId: 'fallback-ryan-restrained',
  })
  built.push(result)
  return { factories: result.factories, workspaceRoot, transports }
}

describe.skipIf(!TOOLCHAIN_PRESENT)('real adapter factories over fake transports', () => {
  it('persists jobs in SQLite at the driver’s layout, visible across connections', async () => {
    const { factories, workspaceRoot } = await buildRealFactories()
    expect(factories.jobs).toBeInstanceOf(SqliteJobRepository)
    expect(factories.approvals).toBeInstanceOf(SqliteFallbackApprovalRepository)

    // A second, independent connection — the driver's position — writes a job; the factory's
    // repository reads it back. In-memory defaults cannot satisfy this either direction.
    const layout = layoutFor(workspaceRoot)
    const other = openWorkspace(layout)
    try {
      const writer = new SqliteJobRepository(layout, other)
      await writer.saveJob(new AudiobookJob('job-written-by-another-process'))
      const seen = await factories.jobs?.findJob('job-written-by-another-process')
      expect(seen?.id).toBe('job-written-by-another-process')
    } finally {
      other.close()
    }
  })

  it('binds the director identity from configuration, with the environment pinned out (#54)', async () => {
    const { factories, transports } = await buildRealFactories()
    const settings = {
      baseUrl: transports.director.baseUrl,
      confidenceThreshold: 0.5,
      gpuLeaseLockFilePath: transports.gpu.lockFilePath,
    }

    expect(factories.directorIdentity).toBe(createDirectorContentIdentity(settings))
    // The load-bearing #54 property, stated positively: a port move cannot move the identity.
    expect(factories.directorIdentity).toBe(
      createDirectorContentIdentity({ ...settings, baseUrl: 'http://127.0.0.1:19999/v1' }),
    )
    // And negatively: the identity is NOT the adapter's self-reported one, which hashes the
    // baseUrl and lock path in — the value that wedged resumable jobs.
    expect(factories.directorIdentity).not.toBe(createGemmaDirectorIdentity(settings))
  })

  it('constructs a fresh, identity-agreeing director per call and never a shared one', async () => {
    const { factories } = await buildRealFactories()
    expect(factories.createDirectorModel).toBeDefined()

    const first = await factories.createDirectorModel?.()
    const second = await factories.createDirectorModel?.()
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    // DirectAudiobook releases a director whose identity disagrees with the factory's, then fails
    // the run — so agreement is asserted, not assumed.
    expect(first?.identity).toBe(factories.directorIdentity)
    expect(second?.identity).toBe(factories.directorIdentity)
    // A retained director would serve the first book and throw 'has been released' on every book
    // after it, because release() is terminal. Distinct instances are the whole point.
    expect(second).not.toBe(first)
    await first?.release()
    await second?.release()
  })

  it('shares one speech engine across per-book factories, with a stable identity', async () => {
    const { factories } = await buildRealFactories()
    const factory = factories.speechEngineFactory
    expect(factory?.identity).toEqual(expect.any(String))
    expect(factory?.identity.length).toBeGreaterThan(0)

    const context = { bookId: 'book-1', fallbackApprovals: [] }
    const first = await factory?.create(context)
    const second = await factory?.create(context)
    expect(first?.identity).toBe(factory?.identity)
    expect(second?.identity).toBe(factory?.identity)
    // endBatch() is not terminal for the real Qwen adapter and PLAN.md wants the model kept
    // loaded, so the engine underneath is shared; the per-book wrapper is not.
    expect(second).not.toBe(first)
  })

  it('supplies the real extractor and a shared real assembler', async () => {
    const { factories } = await buildRealFactories()
    expect(await factories.createEpubExtractor?.()).toBeInstanceOf(DomainEpubExtractor)
    const assembler = await factories.createAudioAssembler?.()
    expect(assembler).toBeInstanceOf(FfmpegAudioAssembler)
    expect(await factories.createAudioAssembler?.()).toBe(assembler)
  })

  it('closes the SQLite handle it opened', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'lna-web-real-adapters-'))
    roots.push(workspaceRoot)
    const workspace = await createWorkspace(workspaceRoot)
    const transports = await createFakeTransports(
      { runtimeDirectory: path.join(workspaceRoot, 'runtime'), repositoryRoot: REPOSITORY_ROOT },
      'http://127.0.0.1:18080/v1',
    )
    transportsToClose.push(transports)
    const result = await createRealAdapterFactories({
      workspace,
      repositoryRoot: REPOSITORY_ROOT,
      transports,
      characterSpeakerIds: ['alice'],
      narratorProfileId: 'narrator-aiden-calm',
      fallbackProfileId: 'fallback-ryan-restrained',
    })
    result.close()
    await expect(result.factories.jobs?.findJob('anything')).rejects.toThrow()
  })
})
