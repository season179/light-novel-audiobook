import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Book, Chapter, SourcePassage, StableIds } from '@light-novel-audiobook/domain'
import { GemmaDirectorModel } from '@light-novel-audiobook/gemma-director'
import {
  type ExclusiveGpuLeaseCoordinator,
  FileGpuLeaseCoordinator,
  type GpuLease,
  type GpuOwner,
} from '@light-novel-audiobook/gpu-lease'
import { afterEach, describe, expect, it } from 'vitest'
import { NarrationEchoDirectorServer } from '../src/fake-director-server.js'
import { OwnedLlamaLifecycle } from '../src/llama-lifecycle.js'

const STUB = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/stub-llama-server.mjs',
)
const SOURCE_SHA256 = 'b'.repeat(64)

const directories: string[] = []
const servers: NarrationEchoDirectorServer[] = []
const lifecycles: OwnedLlamaLifecycle[] = []

afterEach(async () => {
  for (const lifecycle of lifecycles.splice(0)) await lifecycle.release().catch(() => undefined)
  for (const server of servers.splice(0)) await server.stop()
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }
      probe.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    return true
  }
}

/**
 * Wraps the real cross-process lease and, at the instant an owner acquires it, records whether the
 * director's owned process is still alive. That instant is the one that matters: it is when the speech
 * engine would begin loading 16 GB of Qwen weights.
 */
class ProcessProbingCoordinator implements ExclusiveGpuLeaseCoordinator {
  readonly observations: { owner: GpuOwner; directorProcessAlive: boolean | 'never-started' }[] = []

  constructor(
    private readonly inner: ExclusiveGpuLeaseCoordinator,
    private readonly directorPid: () => number | undefined,
  ) {}

  async acquire(owner: GpuOwner, signal?: AbortSignal): Promise<GpuLease> {
    const lease = await this.inner.acquire(owner, signal)
    const pid = this.directorPid()
    this.observations.push({
      owner,
      directorProcessAlive: pid === undefined ? 'never-started' : processAlive(pid),
    })
    return lease
  }
}

function smokeBook(): { book: Book; chapter: Chapter } {
  const bookId = StableIds.book(SOURCE_SHA256)
  const chapterId = StableIds.chapter(bookId, 1)
  const chapter = new Chapter({
    id: chapterId,
    bookId,
    position: 1,
    title: 'Ordering Probe',
    sourcePassages: [
      new SourcePassage({
        id: StableIds.passage(chapterId, 1),
        chapterId,
        sourceText: 'The lantern went out.',
      }),
    ],
  })
  return {
    book: new Book({
      id: bookId,
      title: 'Ordering Probe',
      author: null,
      coverPath: null,
      source: { epubPath: '/nonexistent/ordering-probe.epub', sha256: SOURCE_SHA256 },
      chapters: [chapter],
    }),
    chapter,
  }
}

/** True only when nvidia-smi reports a real card, matching the #62 smoke-test gate. */
function nvidiaGpuPresent(): boolean {
  try {
    const output = execFileSync(
      'nvidia-smi',
      ['--query-gpu=memory.total', '--format=csv,noheader,nounits'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
    return output
      .split(/\r?\n/u)
      .map((line) => Number(line.trim()))
      .some((value) => Number.isFinite(value) && value > 0)
  } catch {
    return false
  }
}

const GPU_PRESENT = nvidiaGpuPresent()
const SKIP_REASON = 'no NVIDIA GPU visible to nvidia-smi'
if (!GPU_PRESENT) {
  process.stderr.write(
    `[skipped] real director lifecycle ordering did not run: ${SKIP_REASON}.\n` +
      `[skipped] This test needs a real GPU + kernel flock; it is expected to skip on CI.\n`,
  )
}

describe.skipIf(!GPU_PRESENT)(
  GPU_PRESENT
    ? 'real director lifecycle ordering'
    : `real director lifecycle ordering [SKIPPED: ${SKIP_REASON}]`,
  () => {
    it('has reaped the owned llama process before the GPU lease reaches the speech engine', async () => {
      const runtimeRoot = await mkdtemp(path.join(tmpdir(), 'ordering-runtime-'))
      directories.push(runtimeRoot)
      const echo = new NarrationEchoDirectorServer()
      servers.push(echo)
      await echo.start()

      const port = await freePort()
      const lifecycle = new OwnedLlamaLifecycle({
        binaryPath: process.execPath,
        args: [STUB, String(port), echo.baseUrl],
        apiKey: 'ordering-probe-key',
        keyPath: path.join(runtimeRoot, 'api-key'),
        origin: `http://127.0.0.1:${port}`,
        port,
        startupTimeoutMs: 30_000,
        terminateTimeoutMs: 2_000,
        killTimeoutMs: 5_000,
      })
      lifecycles.push(lifecycle)

      // The real cross-process lease, so "Qwen could acquire" is a real kernel fact, not a flag.
      const coordinator = new ProcessProbingCoordinator(
        new FileGpuLeaseCoordinator({
          lockFilePath: path.join(runtimeRoot, 'exclusive.lock'),
          // The kernel flock is the real cross-process guarantee; the nvidia-smi foreign-process
          // diagnostic is advisory and under WSL2/GPU-PV can list dead PIDs as [Not Found]/[N/A]
          // (#68). The #21 race tests disable it for the same reason. The ordering proof below is
          // observed process state, not the diagnostic.
          inspectExistingComputeProcesses: false,
        }),
        () => lifecycle.processId,
      )

      const { book, chapter } = smokeBook()
      const director = new GemmaDirectorModel({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'ordering-probe-key',
        confidenceThreshold: 0.5,
        contextProvider: {
          forChapter: async () => ({
            speakers: [],
            narratorSpeakerId: 'narrator',
            fallbackSpeakerId: 'fallback',
          }),
        },
        progressStore: { append: async () => undefined },
        lifecycle,
        gpuLeaseCoordinator: coordinator,
        gpuLeaseLockFilePath: path.join(runtimeRoot, 'exclusive.lock'),
      })

      // The adapter acquires the lease, then start()s the runtime: direction only succeeds if the owned
      // process is genuinely serving, because every request is proxied through it.
      const directed = await director.directChapter(book, chapter)
      expect(directed.chapterId).toBe(chapter.id)
      expect(directed.segments).toHaveLength(1)

      const pid = lifecycle.processId
      if (pid === undefined) throw new Error('director never started an owned process')
      expect(processAlive(pid)).toBe(true)

      // The adapter releases the runtime before it releases the lease.
      await director.release()

      // Now the speech engine takes its turn, exactly as GenerateAudiobook does after directBook.
      const speechLease = await coordinator.acquire('qwen3-tts')
      await speechLease.release()

      expect(coordinator.observations.map((observation) => observation.owner)).toEqual([
        'gemma',
        'qwen3-tts',
      ])
      // THE ASSERTION THIS TEST EXISTS FOR. Observed process state at the moment Qwen holds the lease —
      // a recorded 'director:release' string would pass even with the model still resident in VRAM.
      const speechObservation = coordinator.observations.find(
        (observation) => observation.owner === 'qwen3-tts',
      )
      expect(speechObservation?.directorProcessAlive).toBe(false)
      expect(processAlive(pid)).toBe(false)
    }, 120_000)

    it('fails if the runtime outlives release, which a recording lifecycle would not catch', async () => {
      // Guard the guard: with a lifecycle that only records — the shape this driver used to ship — the
      // probe above must observe a live process. If this ever passes with `false`, the probe is broken.
      const runtimeRoot = await mkdtemp(path.join(tmpdir(), 'ordering-negative-'))
      directories.push(runtimeRoot)
      const echo = new NarrationEchoDirectorServer()
      servers.push(echo)
      await echo.start()

      const port = await freePort()
      const unmanaged = new OwnedLlamaLifecycle({
        binaryPath: process.execPath,
        args: [STUB, String(port), echo.baseUrl],
        apiKey: 'ordering-negative-key',
        keyPath: path.join(runtimeRoot, 'api-key'),
        origin: `http://127.0.0.1:${port}`,
        port,
        startupTimeoutMs: 30_000,
        terminateTimeoutMs: 2_000,
        killTimeoutMs: 5_000,
      })
      lifecycles.push(unmanaged)
      await unmanaged.start()
      const pid = unmanaged.processId
      if (pid === undefined) throw new Error('stub process did not start')

      const coordinator = new ProcessProbingCoordinator(
        new FileGpuLeaseCoordinator({
          lockFilePath: path.join(runtimeRoot, 'exclusive.lock'),
          inspectExistingComputeProcesses: false,
        }),
        () => pid,
      )
      // A no-op release: the string is recorded, the process keeps running, the VRAM stays occupied.
      const recorded: string[] = []
      recorded.push('director:release')

      const speechLease = await coordinator.acquire('qwen3-tts')
      await speechLease.release()

      expect(recorded).toContain('director:release')
      // The recorded event says released; the kernel says otherwise. This is the bug the fix removes.
      expect(coordinator.observations[0]?.directorProcessAlive).toBe(true)
    }, 120_000)
  },
)
