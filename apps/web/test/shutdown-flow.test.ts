import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { DirectChapterOptions, DirectedChapter } from '@light-novel-audiobook/application'
import type { Book, Chapter } from '@light-novel-audiobook/domain'
import { OwnedLlamaLifecycle } from '@light-novel-audiobook/gemma-director'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stopAppResponse } from '../src/routes/api.stop.js'
import { createAudiobookComposition } from '../src/server/composition-root.js'
import { FakeDirectorModel } from '../src/server/fakes/fake-director-model.js'
import { InMemoryJobRepository } from '../src/server/fakes/in-memory-job-repository.js'
import { GenerationRunner } from '../src/server/generation-runner.js'
import { resolveReviewerIdentity } from '../src/server/reviewer-identity.js'
import { ShutdownController } from '../src/server/shutdown-controller.js'
import { createWorkspace } from '../src/server/workspace.js'
import { createStubEpubBytes } from './support/stub-epub.js'
import { waitForJobState } from './support/test-harness.js'

const roots: string[] = []
const TEST_REVIEWER = resolveReviewerIdentity({ LNA_REVIEWER: 'shutdown-test' })

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const emptyRunner = () =>
  new GenerationRunner({
    createDirection: async () => {
      throw new Error('No direction operation should be created')
    },
    createRendering: async () => {
      throw new Error('No render operation should be created')
    },
  })

describe('clean process stop', () => {
  it('releases with nothing running and requests process exit exactly once after the response exists', async () => {
    const released = vi.fn(async () => undefined)
    const closed = vi.fn(() => undefined)
    const exit = vi.fn()
    const scheduled: Array<() => void> = []
    const shutdown = new ShutdownController(emptyRunner(), {
      releaseOwnedResources: released,
      closeResources: closed,
      exit,
      scheduleExit: (callback) => scheduled.push(callback),
    })

    const response = await stopAppResponse({ api: {} as never, shutdown })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ stopped: true })
    expect(released).toHaveBeenCalledOnce()
    expect(closed).toHaveBeenCalledOnce()
    expect(exit).not.toHaveBeenCalled()
    expect(scheduled).toHaveLength(1)

    shutdown.exitAfterResponse()
    expect(scheduled).toHaveLength(1)
    scheduled[0]?.()
    expect(exit).toHaveBeenCalledExactlyOnceWith(0)
  })

  it('empirically reaps an owned llama-server child before shutdown resolves', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lna-stop-owned-'))
    roots.push(root)
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{}')
    })
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject)
      upstream.listen(0, '127.0.0.1', resolve)
    })
    const upstreamPort = (upstream.address() as { port: number }).port
    const probe = createServer()
    const port = await new Promise<number>((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(0, '127.0.0.1', () => {
        const selected = (probe.address() as { port: number }).port
        probe.close((error) => (error ? reject(error) : resolve(selected)))
      })
    })
    const lifecycle = new OwnedLlamaLifecycle({
      binaryPath: process.execPath,
      args: [
        path.resolve('packages/pipeline-driver/test/fixtures/stub-llama-server.mjs'),
        String(port),
        `http://127.0.0.1:${upstreamPort}`,
      ],
      apiKey: 'shutdown-empirical-key',
      keyPath: path.join(root, 'api-key'),
      origin: `http://127.0.0.1:${port}`,
      port,
      startupTimeoutMs: 10_000,
      terminateTimeoutMs: 2_000,
      killTimeoutMs: 3_000,
    })
    try {
      await lifecycle.start()
      const pid = lifecycle.processId
      if (pid === undefined) throw new Error('Owned stub process did not start')
      expect(() => process.kill(pid, 0)).not.toThrow()

      const shutdown = new ShutdownController(emptyRunner(), {
        releaseOwnedResources: () => lifecycle.release(),
      })
      await shutdown.prepare()

      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    } finally {
      await lifecycle.release().catch(() => undefined)
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  }, 20_000)

  it('fake mode acquires no adapters or processes, releases nothing, and still exits', async () => {
    const exit = vi.fn()
    const scheduled: Array<() => void> = []
    const shutdown = new ShutdownController(emptyRunner(), {
      exit,
      scheduleExit: (callback) => scheduled.push(callback),
    })

    await shutdown.prepare()
    shutdown.exitAfterResponse()
    scheduled[0]?.()

    expect(exit).toHaveBeenCalledExactlyOnceWith(0)
  })

  it('stops mid-direction in a resumable state, then a restarted composition completes it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lna-stop-resume-'))
    roots.push(root)
    const workspace = await createWorkspace(root)
    const jobs = new InMemoryJobRepository(workspace)
    const controller = new AbortController()
    let calls = 0

    class BlockingDirector extends FakeDirectorModel {
      override async directChapter(
        book: Book,
        chapter: Chapter,
        options?: DirectChapterOptions,
      ): Promise<DirectedChapter> {
        calls += 1
        if (calls === 2) {
          await new Promise<void>((_resolve, reject) => {
            const signal = options?.signal
            if (signal?.aborted === true) {
              reject(new Error('Direction stopped'))
              return
            }
            signal?.addEventListener('abort', () => reject(new Error('Direction stopped')), {
              once: true,
            })
          })
        }
        return super.directChapter(book, chapter, options)
      }
    }

    const first = await createAudiobookComposition({
      workspace,
      jobs,
      reviewer: TEST_REVIEWER,
      directorIdentity: new FakeDirectorModel().identity,
      createDirectorModel: () => new BlockingDirector(),
      runtimeShutdown: { controller },
    })
    const upload = await first.api.uploadEpub({
      fileName: 'stop-resume.epub',
      bytes: createStubEpubBytes('stop-resume'),
    })
    const started = await first.api.startGeneration({ uploadId: upload.uploadId })
    await waitForJobState(
      first.api,
      started.jobId,
      (job) => job.state === 'running' && job.completedChapters === 1,
    )

    const preview = await first.api.getStopPreview()
    expect(preview.inFlight?.operation).toContain('Directing')
    expect(preview.inFlight?.checkpoint).toContain('completed directed chapter')
    await first.shutdown.prepare()

    const stopped = await first.api.requireJobState({ jobId: started.jobId })
    expect(stopped.state).toBe('abandoned')
    expect(stopped.resumeDescription).toContain('Completed chapters stay saved')
    expect(stopped.completedChapters).toBe(1)

    const restarted = await createAudiobookComposition({
      workspace,
      jobs,
      reviewer: TEST_REVIEWER,
    })
    await restarted.api.resumeGeneration({ jobId: started.jobId })
    const completed = await waitForJobState(
      restarted.api,
      started.jobId,
      (job) => job.state === 'completed',
    )

    expect(completed.state).toBe('completed')
  }, 20_000)
})
