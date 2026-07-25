import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type ExclusiveGpuGate,
  type GpuLease,
  type GpuOwner,
  QwenTtsSpeechEngine,
  SpeechEngineError,
  type SpeechProgressEvent,
  type SpeechSegmentRequest,
} from '../src/index.js'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPOSITORY_ROOT = resolve(PACKAGE_ROOT, '../..')
const PRODUCTION_CONFIG = join(REPOSITORY_ROOT, 'config/qwen3-tts-production.json')
const MODEL_LOCK = join(REPOSITORY_ROOT, 'config/qwen3-tts-custom-voice.lock.json')
const UV_LOCK = join(REPOSITORY_ROOT, 'scripts/qwen3-tts-runtime/uv.lock')
const FAKE_WORKER = join(PACKAGE_ROOT, 'test/fixtures/fake-qwen-process.mjs')

class RecordingGpuGate implements ExclusiveGpuGate {
  acquisitions = 0
  releases = 0

  async acquire(_owner: GpuOwner, signal?: AbortSignal): Promise<GpuLease> {
    if (signal?.aborted) throw new Error('aborted')
    this.acquisitions += 1
    let released = false
    return {
      release: async () => {
        if (!released) this.releases += 1
        released = true
      },
    }
  }
}

const roots: Array<string> = []

async function makeEngine(
  mode = 'normal',
  extraEnvironment: Readonly<Record<string, string>> = {},
): Promise<{
  engine: QwenTtsSpeechEngine
  root: string
  output: string
  log: string
  gate: RecordingGpuGate
}> {
  const root = join(tmpdir(), `qwen-tts-contract-${crypto.randomUUID()}`)
  roots.push(root)
  const output = join(root, 'audio')
  const snapshot = join(root, 'snapshot')
  const log = join(root, 'invocations.jsonl')
  const runtimeManifest = join(root, 'runtime-manifest.json')
  await import('node:fs/promises').then(({ mkdir }) =>
    Promise.all([mkdir(output, { recursive: true }), mkdir(snapshot, { recursive: true })]),
  )
  await writeFile(runtimeManifest, '{}\n')
  const gate = new RecordingGpuGate()
  const engine = await QwenTtsSpeechEngine.create({
    pythonExecutable: process.execPath,
    workerScriptPath: FAKE_WORKER,
    productionConfigPath: PRODUCTION_CONFIG,
    modelLockPath: MODEL_LOCK,
    runtimeManifestPath: runtimeManifest,
    uvLockPath: UV_LOCK,
    snapshotPath: snapshot,
    outputDirectory: output,
    repositoryRoot: REPOSITORY_ROOT,
    gpuGate: gate,
    processEnvironment: { FAKE_QWEN_MODE: mode, FAKE_QWEN_LOG: log, ...extraEnvironment },
    cancellationGraceMs: 500,
  })
  return { engine, root, output, log, gate }
}

async function invocations(path: string): Promise<Array<Record<string, unknown>>> {
  try {
    return (await readFile(path, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  } catch {
    return []
  }
}

function invocationSegmentIds(
  calls: ReadonlyArray<Record<string, unknown>>,
  index: number,
): Array<unknown> {
  const segments = calls[index]?.segments
  if (!Array.isArray(segments)) throw new Error(`Invocation ${index} has no segment array`)
  return segments.map((item) => (item as Record<string, unknown>).segmentId)
}

async function expectCode(
  promise: Promise<unknown>,
  code: SpeechEngineError['code'],
): Promise<SpeechEngineError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(SpeechEngineError)
    expect((error as SpeechEngineError).code).toBe(code)
    return error as SpeechEngineError
  }
  throw new Error(`Expected ${code}`)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('QwenTtsSpeechEngine fake-process contract', () => {
  it('loads one process once, renders the ordered selected profiles serially, and records fallback identity', async () => {
    const { engine, log, gate } = await makeEngine()
    expect(engine.identity).toMatch(/^[0-9a-f]{64}$/)
    const events: Array<SpeechProgressEvent> = []
    const requests: Array<SpeechSegmentRequest> = [
      {
        segmentId: 'book-0123456789abcdef01234567-ch0001-p000001-s0001',
        text: 'The lantern waited beside the silent gate.',
        voiceProfileId: 'aiden-calm-narrator',
      },
      {
        segmentId: 'ch01-0002',
        text: 'Come on, we can still catch them!',
        voiceProfileId: 'ryan-energetic-baseline',
      },
      { segmentId: 'ch01-0003', text: 'I knew the road would end here.' },
    ]

    const result = await engine.renderBatch(requests, { onProgress: (event) => events.push(event) })

    expect(result.rendered).toBe(3)
    expect(result.reused).toBe(0)
    expect(result.results.map((item) => item.segmentId)).toEqual(
      requests.map((item) => item.segmentId),
    )
    expect(result.results.map((item) => item.voiceProfileId)).toEqual([
      'aiden-calm-narrator',
      'ryan-energetic-baseline',
      'ryan-low-weary',
    ])
    expect(result.results.map((item) => item.usedFallback)).toEqual([false, false, true])
    expect(result.results.every((item) => item.audio.sampleRateHz === 24_000)).toBe(true)
    const calls = await invocations(log)
    expect(calls).toHaveLength(1)
    expect(invocationSegmentIds(calls, 0)).toEqual(requests.map((item) => item.segmentId))
    expect(
      (calls[0]?.segments as Array<Record<string, unknown>> | undefined)?.map((item) => item.text),
    ).toEqual(requests.map((item) => item.text))
    expect(events.filter((event) => event.type === 'model-loaded')).toHaveLength(1)
    expect(
      events
        .filter((event) => event.type === 'segment-started')
        .map((event) => 'segmentId' in event && event.segmentId),
    ).toEqual(requests.map((item) => item.segmentId))
    expect(events.at(-1)).toEqual({ type: 'batch-completed', rendered: 3, reused: 0 })
    expect(gate.acquisitions).toBe(1)
    expect(gate.releases).toBe(1)
  })

  it('reuses validated WAVs on restart without launching Python', async () => {
    const fixture = await makeEngine()
    const request = [
      {
        segmentId: 'ch02-0001',
        text: 'Nothing moved beneath the moon.',
        voiceProfileId: 'aiden-calm-narrator',
      },
    ] as const
    const first = await fixture.engine.renderBatch(request)
    const firstResult = first.results[0]
    if (!firstResult) throw new Error('Initial render result is missing')
    const wavBefore = await stat(firstResult.wavPath)

    const second = await fixture.engine.renderBatch(request)

    expect(second).toMatchObject({ rendered: 0, reused: 1 })
    expect(second.results[0]?.status).toBe('reused')
    expect(await invocations(fixture.log)).toHaveLength(1)
    expect((await stat(firstResult.wavPath)).mtimeMs).toBe(wavBefore.mtimeMs)
  })

  it('invalidates only a segment whose exact text or voice changes', async () => {
    const fixture = await makeEngine()
    const original: Array<SpeechSegmentRequest> = [
      {
        segmentId: 'ch03-0001',
        text: 'First line stays here.',
        voiceProfileId: 'aiden-calm-narrator',
      },
      {
        segmentId: 'ch03-0002',
        text: 'Second line will change.',
        voiceProfileId: 'ryan-energetic-baseline',
      },
      {
        segmentId: 'ch03-0003',
        text: 'Third line changes voices.',
        voiceProfileId: 'ryan-low-weary',
      },
    ]
    const initial = await fixture.engine.renderBatch(original)
    const initialHashes = initial.results.map((item) => item.audio.sha256)

    const textChanged = original.map((item) =>
      item.segmentId === 'ch03-0002'
        ? { ...item, text: 'Second line now has several additional words.' }
        : item,
    )
    const second = await fixture.engine.renderBatch(textChanged)
    expect(second.results.map((item) => item.status)).toEqual(['reused', 'rendered', 'reused'])
    expect(second.results[0]?.audio.sha256).toBe(initialHashes[0])
    expect(second.results[2]?.audio.sha256).toBe(initialHashes[2])

    const voiceChanged = textChanged.map((item) =>
      item.segmentId === 'ch03-0003'
        ? { ...item, voiceProfileId: 'ryan-energetic-baseline' as const }
        : item,
    )
    const third = await fixture.engine.renderBatch(voiceChanged)
    expect(third.results.map((item) => item.status)).toEqual(['reused', 'reused', 'rendered'])
    const calls = await invocations(fixture.log)
    expect(calls).toHaveLength(3)
    expect(invocationSegmentIds(calls, 1)).toEqual(['ch03-0002'])
    expect(invocationSegmentIds(calls, 2)).toEqual(['ch03-0003'])
  })

  it('rerenders only a corrupted cached WAV', async () => {
    const fixture = await makeEngine()
    const requests = [
      {
        segmentId: 'ch04-0001',
        text: 'Keep this valid clip.',
        voiceProfileId: 'aiden-calm-narrator' as const,
      },
      {
        segmentId: 'ch04-0002',
        text: 'Corrupt only this clip.',
        voiceProfileId: 'ryan-low-weary' as const,
      },
    ]
    const first = await fixture.engine.renderBatch(requests)
    const corruptResult = first.results[1]
    if (!corruptResult) throw new Error('Corruption target is missing')
    await writeFile(corruptResult.wavPath, 'corrupt')

    const resumed = await fixture.engine.renderBatch(requests)

    expect(resumed.results.map((item) => item.status)).toEqual(['reused', 'rendered'])
    const calls = await invocations(fixture.log)
    expect(invocationSegmentIds(calls, 1)).toEqual(['ch04-0002'])
  })

  it.each([
    ['malformed-event', 'protocol'],
    ['wrong-order', 'protocol'],
    ['wrong-hash', 'protocol'],
    ['invalid-wav', 'audio-validation'],
    ['process-failure-before-load', 'process-failed'],
    ['duplicate-render', 'protocol'],
  ] as const)('rejects adversarial fake process mode %s', async (mode, code) => {
    const { engine, gate } = await makeEngine(mode)
    const error = await expectCode(
      engine.renderBatch([
        {
          segmentId: 'ch05-0001',
          text: 'Adversarial protocol line.',
          voiceProfileId: 'aiden-calm-narrator',
        },
      ]),
      code,
    )
    if (mode === 'process-failure-before-load')
      expect(error.message).toContain('synthetic model load failure')
    expect(gate.releases).toBe(1)
  })

  it('rejects unsafe and duplicate stable IDs before spawning', async () => {
    const fixture = await makeEngine()
    await expectCode(
      fixture.engine.renderBatch([{ segmentId: '../escape', text: 'No.' }]),
      'configuration',
    )
    await expectCode(
      fixture.engine.renderBatch([
        { segmentId: 'ch06-0001', text: 'One.' },
        { segmentId: 'ch06-0001', text: 'Two.' },
      ]),
      'configuration',
    )
    expect(await invocations(fixture.log)).toHaveLength(0)
  })

  it('terminates the batch process on cancellation and always releases the GPU', async () => {
    const cancelLog = join(tmpdir(), `qwen-tts-cancel-${crypto.randomUUID()}.log`)
    roots.push(cancelLog)
    const fixture = await makeEngine('hang', { FAKE_QWEN_CANCEL_LOG: cancelLog })
    const controller = new AbortController()
    let modelLoaded = false
    const render = fixture.engine.renderBatch(
      [
        {
          segmentId: 'ch07-0001',
          text: 'Wait until cancellation arrives.',
          voiceProfileId: 'ryan-low-weary',
        },
      ],
      {
        signal: controller.signal,
        onProgress: (event) => {
          if (event.type === 'model-loaded') {
            modelLoaded = true
            controller.abort()
          }
        },
      },
    )

    await expectCode(render, 'cancelled')
    expect(modelLoaded).toBe(true)
    expect(fixture.gate.releases).toBe(1)
    expect(await readFile(cancelLog, 'utf8')).toContain('terminated')
  })
})
