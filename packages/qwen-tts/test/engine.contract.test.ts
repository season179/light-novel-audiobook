import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import {
  appendFile,
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { Segment, VoiceProfile } from '@light-novel-audiobook/domain'
import { afterEach, describe, expect, it } from 'vitest'
import {
  deriveSeed,
  type ExclusiveGpuGate,
  type FallbackApprovalRecord,
  type GpuLease,
  type GpuOwner,
  loadProductionConfig,
  MAX_SEED_ATTEMPTS,
  prepareEmptySmokeOutputRoot,
  QwenApplicationSpeechEngine,
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
const BOOK = 'book-0123456789abcdef01234567'

const FALLBACK_APPROVAL = {
  approvalId: 'review-fallback-0001',
  approvalSha256: 'a'.repeat(64),
} as const

const segmentApproval = (
  segmentId: string,
  overrides: Partial<FallbackApprovalRecord> = {},
): FallbackApprovalRecord => ({
  segmentId,
  speakerId: null,
  fallbackReason: 'unresolved_speaker',
  ...FALLBACK_APPROVAL,
  ...overrides,
})

class RecordingGpuGate implements ExclusiveGpuGate {
  acquisitions = 0
  releases = 0
  onRelease: (() => void | Promise<void>) | undefined
  lifecycleLog: string | undefined

  #mark(event: string): void {
    if (this.lifecycleLog !== undefined) appendFileSync(this.lifecycleLog, `${event}\n`)
  }

  async acquire(owner: GpuOwner, signal?: AbortSignal): Promise<GpuLease> {
    if (signal?.aborted) throw new Error('aborted')
    this.acquisitions += 1
    this.#mark('lease-acquired')
    let released = false
    return {
      owner,
      lockFilePath: '/fixture/gpu.lock',
      quarantine: async () => undefined,
      release: async () => {
        if (!released) {
          await this.onRelease?.()
          this.releases += 1
          this.#mark('lease-released')
        }
        released = true
      },
    }
  }
}

const roots: Array<string> = []

async function makeEngine(
  mode = 'normal',
  extraEnvironment: Readonly<Record<string, string>> = {},
  engineOptions: {
    readonly allowOverwriteExisting?: boolean
    readonly pythonExecutable?: string
    readonly allowUnscopedSegmentIds?: boolean
    /** Rebuilds an engine over an existing fixture root, as a restarted process would. */
    readonly reuseRoot?: string
  } = {},
): Promise<{
  engine: QwenTtsSpeechEngine
  root: string
  output: string
  log: string
  workerScriptPath: string
  lifecycleLog: string
  gate: RecordingGpuGate
}> {
  const { reuseRoot, ...overrides } = engineOptions
  const root = reuseRoot ?? join(tmpdir(), `qwen-tts-contract-${crypto.randomUUID()}`)
  const output = join(root, 'audio')
  const snapshot = join(root, 'snapshot')
  const log = join(root, 'invocations.jsonl')
  const runtimeManifest = join(root, 'runtime-manifest.json')
  // Each fixture root owns its worker copy so a test can mutate the pinned worker in isolation.
  const workerScriptPath = join(root, 'fake-qwen-process.mjs')
  if (reuseRoot === undefined) {
    roots.push(root)
    await Promise.all([mkdir(output, { recursive: true }), mkdir(snapshot, { recursive: true })])
    await copyFile(FAKE_WORKER, workerScriptPath)
    await writeFile(
      runtimeManifest,
      `${JSON.stringify({
        schemaVersion: 1,
        immutable: true,
        pythonVersion: '3.12.13',
        uvLockSha256: '6a7d989924871b408ed0e6eea86ce21ff399033e1272c5fa19bf9a5e38c3bbd9',
        packages: [
          { name: 'qwen-tts', version: '0.1.1' },
          { name: 'torch', version: '2.9.1' },
          { name: 'torchaudio', version: '2.9.1' },
        ],
      })}\n`,
    )
  }
  // Shared by every engine over this root, so a restart appends to one ordered timeline.
  const lifecycleLog = join(root, 'lifecycle.log')
  const gate = new RecordingGpuGate()
  gate.lifecycleLog = lifecycleLog
  const engine = await QwenTtsSpeechEngine.create({
    pythonExecutable: process.execPath,
    workerScriptPath,
    productionConfigPath: PRODUCTION_CONFIG,
    modelLockPath: MODEL_LOCK,
    runtimeManifestPath: runtimeManifest,
    uvLockPath: UV_LOCK,
    snapshotPath: snapshot,
    outputDirectory: output,
    repositoryRoot: REPOSITORY_ROOT,
    gpuGate: gate,
    processEnvironment: {
      FAKE_QWEN_MODE: mode,
      FAKE_QWEN_LOG: log,
      FAKE_QWEN_LIFECYCLE_LOG: lifecycleLog,
      ...extraEnvironment,
    },
    cancellationGraceMs: 500,
    allowUnscopedSegmentIds: true,
    ...overrides,
  })
  return { engine, root, output, log, workerScriptPath, lifecycleLog, gate }
}

async function lifecycle(path: string): Promise<Array<string>> {
  return (await readFile(path, 'utf8').catch(() => '')).split('\n').filter(Boolean)
}

async function pathPresent(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
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
    const { engine, log, gate, root, workerScriptPath } = await makeEngine()
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
      {
        segmentId: 'ch01-0003',
        text: 'I knew the road would end here.',
        fallbackApproval: FALLBACK_APPROVAL,
      },
    ]

    const result = await engine.renderBatch(requests, {
      onProgress: (event) => {
        events.push(event)
      },
    })

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
    expect(calls[0]?.workerSha256).toBe(
      createHash('sha256')
        .update(await readFile(workerScriptPath))
        .digest('hex'),
    )
    expect(calls[0]?.runtimeManifestSha256).toBe(
      createHash('sha256')
        .update(await readFile(join(root, 'runtime-manifest.json')))
        .digest('hex'),
    )
    expect(calls[0]?.ambientPython).toEqual({
      PYTHONHOME: null,
      PYTHONPATH: null,
      PYTHONSTARTUP: null,
    })
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

  it('pins the compatibility engine and application adapter identities', async () => {
    const fixture = await makeEngine()
    expect(fixture.engine.identity).toBe(
      '25c691024e8b7681364d4352e3940f9870ca349dfd63214a46d5129f0276b108',
    )
    expect(new QwenApplicationSpeechEngine(fixture.engine).identity).toBe(
      'e53a04582273ccaa1df0dfb25d458e74e42eb934ebef6a125e883edd26ddb119',
    )
    expect(fixture.gate.acquisitions).toBe(0)
  })

  it('retries a gate failure in renderBatch and keeps later stale segments in the replacement', async () => {
    const fixture = await makeEngine('health-gate-once')
    const events: SpeechProgressEvent[] = []
    const requests: SpeechSegmentRequest[] = [
      {
        segmentId: 'ch01-0101',
        text: 'Synthetic first retry fixture.',
        voiceProfileId: 'ryan-low-weary',
      },
      {
        segmentId: 'ch01-0102',
        text: 'Synthetic replacement-session fixture.',
        voiceProfileId: 'aiden-calm-narrator',
      },
    ]

    const result = await fixture.engine.renderBatch(requests, {
      onProgress: (event) => {
        events.push(event)
      },
    })
    const calls = await invocations(fixture.log)
    const config = await loadProductionConfig(PRODUCTION_CONFIG)
    const profile = config.selectedProfiles.get('ryan-low-weary')
    if (profile === undefined) throw new Error('Pinned retry profile is missing')

    expect(result).toMatchObject({ rendered: 2, reused: 0 })
    expect(calls).toHaveLength(2)
    expect(invocationSegmentIds(calls, 0)).toEqual([requests[0]?.segmentId])
    expect(invocationSegmentIds(calls, 1)).toEqual(requests.map((request) => request.segmentId))
    const firstSegments = calls[0]?.segments
    const replacement = calls[1]?.segments
    if (!Array.isArray(firstSegments) || !Array.isArray(replacement)) {
      throw new Error('Retry invocations are missing segments')
    }
    const firstAttempt = firstSegments[0] as Record<string, unknown> | undefined
    expect(firstAttempt?.seed).toBe(deriveSeed(profile, requests[0]?.segmentId ?? '', 1))
    expect(replacement[0]?.seed).toBe(deriveSeed(profile, requests[0]?.segmentId ?? '', 2))
    expect(
      events
        .filter((event) => event.type === 'segment-rendered')
        .map((event) => ('completed' in event ? event.completed : null)),
    ).toEqual([1, 2])
    expect(fixture.gate.acquisitions).toBe(1)
    expect(fixture.gate.releases).toBe(1)
    expect(await lifecycle(fixture.lifecycleLog)).toEqual([
      'lease-acquired',
      'worker-spawned',
      'worker-exited',
      'worker-spawned',
      'worker-exited',
      'lease-released',
    ])
  })

  it('never retries worker failures without exact health-gate provenance', async () => {
    for (const mode of [
      'health-gate-wrong-detail',
      'health-gate-wrong-segment',
      'process-exit-during-render',
      'wrong-order',
    ]) {
      const fixture = await makeEngine(mode)
      await expect(
        fixture.engine.renderBatch([
          {
            segmentId: 'ch01-0201',
            text: 'Synthetic non-retry fixture.',
            voiceProfileId: 'ryan-low-weary',
          },
        ]),
      ).rejects.toBeInstanceOf(SpeechEngineError)
      expect(
        (await lifecycle(fixture.lifecycleLog)).filter((item) => item === 'worker-spawned'),
      ).toHaveLength(1)
      expect(fixture.gate.acquisitions).toBe(1)
      expect(fixture.gate.releases).toBe(1)
    }
  })

  it('does not retry a progress callback lookalike SpeechEngineError', async () => {
    const fixture = await makeEngine('normal')
    const segmentId = 'ch01-0202'
    const lookalike = new SpeechEngineError(
      'process-failed',
      'Qwen batch worker failed at render-batch: ValueError: generated WAV failed configured health gates',
      { segmentId },
    )

    await expect(
      fixture.engine.renderBatch(
        [{ segmentId, text: 'Synthetic callback fixture.', voiceProfileId: 'ryan-low-weary' }],
        {
          onProgress: (event) => {
            if (event.type === 'segment-started') throw lookalike
          },
        },
      ),
    ).rejects.toBe(lookalike)
    expect(
      (await lifecycle(fixture.lifecycleLog)).filter((item) => item === 'worker-spawned'),
    ).toHaveLength(1)
    expect(fixture.gate.releases).toBe(1)
  })

  it('propagates replacement startup failure without starting a third worker', async () => {
    const fixture = await makeEngine('health-gate-then-load-failure')
    const error = await expectCode(
      fixture.engine.renderBatch([
        {
          segmentId: 'ch01-0203',
          text: 'Synthetic replacement startup failure fixture.',
          voiceProfileId: 'ryan-low-weary',
        },
      ]),
      'process-failed',
    )

    expect(error.message).toContain('synthetic model load failure')
    expect(
      (await lifecycle(fixture.lifecycleLog)).filter((item) => item === 'worker-spawned'),
    ).toHaveLength(2)
    expect(fixture.gate.acquisitions).toBe(1)
    expect(fixture.gate.releases).toBe(1)
  })

  it('stops after four exact gate failures with the last worker error as cause', async () => {
    const fixture = await makeEngine('health-gate-always')
    const segmentId = 'ch01-0301'
    const error = await expectCode(
      fixture.engine.renderBatch([
        { segmentId, text: 'Synthetic exhaustion fixture.', voiceProfileId: 'ryan-low-weary' },
      ]),
      'process-failed',
    )

    expect(error.message).toContain(segmentId)
    expect(error.message).toContain(`${MAX_SEED_ATTEMPTS} attempts`)
    expect(error.cause).toBeInstanceOf(SpeechEngineError)
    expect(await invocations(fixture.log)).toHaveLength(MAX_SEED_ATTEMPTS)
    const workers = (await lifecycle(fixture.lifecycleLog)).filter(
      (item) => item === 'worker-spawned',
    )
    expect(workers).toHaveLength(MAX_SEED_ATTEMPTS)
    expect(fixture.gate.acquisitions).toBe(1)
    expect(fixture.gate.releases).toBe(1)
  })

  it('cancels during replacement startup after a gate fatal and awaits both workers', async () => {
    const fixture = await makeEngine('health-gate-once')
    const controller = new AbortController()
    let starts = 0
    const render = fixture.engine.renderBatch(
      [
        {
          segmentId: 'ch01-0302',
          text: 'Synthetic replacement cancellation fixture.',
          voiceProfileId: 'ryan-low-weary',
        },
      ],
      {
        signal: controller.signal,
        onProgress: (event) => {
          if (event.type === 'process-started') starts += 1
          if (event.type === 'model-loading' && starts === 2) controller.abort()
        },
      },
    )

    await expectCode(render, 'cancelled')
    expect(starts).toBe(2)
    expect(await lifecycle(fixture.lifecycleLog)).toEqual([
      'lease-acquired',
      'worker-spawned',
      'worker-exited',
      'worker-spawned',
      'worker-exited',
      'lease-released',
    ])
    expect(fixture.gate.acquisitions).toBe(1)
    expect(fixture.gate.releases).toBe(1)
  })

  it.each([true, false])(
    'reuses an attempt-2 artifact against the canonical plan with overwrite=%s',
    async (allowOverwriteExisting) => {
      const fixture = await makeEngine('health-gate-once', {}, { allowOverwriteExisting })
      const request = [
        {
          segmentId: 'ch01-0401',
          text: 'Synthetic durable salted artifact fixture.',
          voiceProfileId: 'ryan-low-weary' as const,
        },
      ]
      const rendered = await fixture.engine.renderBatch(request)
      expect(rendered.results[0]?.status).toBe('rendered')
      const renderedHash = rendered.results[0]?.renderIdentitySha256
      expect(await invocations(fixture.log)).toHaveLength(2)

      const restarted = await makeEngine(
        'normal',
        {},
        {
          reuseRoot: fixture.root,
          allowOverwriteExisting,
        },
      )
      const resumed = await restarted.engine.renderBatch(request)
      expect(resumed).toMatchObject({ rendered: 0, reused: 1 })
      expect(resumed.results[0]?.renderIdentitySha256).toBe(renderedHash)
      expect(await invocations(fixture.log)).toHaveLength(2)
      expect(restarted.gate.acquisitions).toBe(0)
    },
  )

  it('rejects Eric and Serena at the TypeScript selection boundary before Python starts', async () => {
    const fixture = await makeEngine()
    const instruction =
      'Speak clearly and naturally, as though reading a line from an audiobook to a single listener.'

    expect(
      fixture.engine.selectedVoiceProfile({ syntheticSpeaker: 'dylan', instruction, seed: 9210 }),
    ).toBe('dylan-neutral-read')
    expect(() =>
      fixture.engine.selectedVoiceProfile({ syntheticSpeaker: 'eric', instruction, seed: 9211 }),
    ).toThrow(/does not match an approved pinned Qwen profile/)
    expect(() =>
      fixture.engine.selectedVoiceProfile({ syntheticSpeaker: 'serena', instruction, seed: 9213 }),
    ).toThrow(/does not match an approved pinned Qwen profile/)
    expect(fixture.gate.acquisitions).toBe(0)
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
    const fixture = await makeEngine(mode)
    const error = await expectCode(
      fixture.engine.renderBatch([
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
    expect(fixture.gate.releases).toBe(1)
    expect(
      (await lifecycle(fixture.lifecycleLog)).filter((item) => item === 'worker-spawned'),
    ).toHaveLength(1)
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

  it('terminates the batch process on cancellation and releases the GPU only after child exit', async () => {
    const cancelLog = join(tmpdir(), `qwen-tts-cancel-${crypto.randomUUID()}.log`)
    roots.push(cancelLog)
    const fixture = await makeEngine('slow-terminate', { FAKE_QWEN_CANCEL_LOG: cancelLog })
    fixture.gate.onRelease = async () => {
      expect(await readFile(cancelLog, 'utf8')).toContain('term-exit')
    }
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
  })

  it('installs child error/close handling before process-started progress', async () => {
    const executable = join(tmpdir(), `qwen-not-executable-${crypto.randomUUID()}`)
    roots.push(executable)
    await writeFile(executable, '# not executable\n', { mode: 0o600 })
    const fixture = await makeEngine('normal', {}, { pythonExecutable: executable })

    await expectCode(
      fixture.engine.renderBatch([
        {
          segmentId: 'ch08-0000',
          text: 'Spawn must fail safely.',
          voiceProfileId: 'aiden-calm-narrator',
        },
      ]),
      'process-failed',
    )
    expect(fixture.gate.releases).toBe(1)
  })

  it('installs abort handling before process-started progress can cancel', async () => {
    const fixture = await makeEngine('hang')
    const controller = new AbortController()
    const render = fixture.engine.renderBatch(
      [
        {
          segmentId: 'ch08-0001',
          text: 'Cancel at first progress.',
          voiceProfileId: 'aiden-calm-narrator',
        },
      ],
      {
        signal: controller.signal,
        onProgress: (event) => {
          if (event.type === 'process-started') controller.abort()
        },
      },
    )

    await expectCode(render, 'cancelled')
    expect(fixture.gate.releases).toBe(1)
  })

  it('terminates and awaits the child when the first progress callback throws', async () => {
    const fixture = await makeEngine('hang')
    await expect(
      fixture.engine.renderBatch(
        [
          {
            segmentId: 'ch09-0000',
            text: 'First callback failure.',
            voiceProfileId: 'aiden-calm-narrator',
          },
        ],
        {
          onProgress: (event) => {
            if (event.type === 'process-started') throw new Error('first progress exploded')
          },
        },
      ),
    ).rejects.toThrow('first progress exploded')
    expect(fixture.gate.releases).toBe(1)
  })

  it('terminates and awaits the child when a later progress callback throws', async () => {
    const fixture = await makeEngine('slow-terminate')
    await expect(
      fixture.engine.renderBatch(
        [
          {
            segmentId: 'ch09-0001',
            text: 'Progress failure.',
            voiceProfileId: 'aiden-calm-narrator',
          },
        ],
        {
          onProgress: (event) => {
            if (event.type === 'model-loaded') throw new Error('progress persistence exploded')
          },
        },
      ),
    ).rejects.toThrow('progress persistence exploded')
    expect(fixture.gate.releases).toBe(1)
  })

  it('requires and records explicit fallback approval identity and hash', async () => {
    const fixture = await makeEngine()
    await expectCode(
      fixture.engine.renderBatch([{ segmentId: 'ch10-0001', text: 'Unapproved fallback.' }]),
      'configuration',
    )
    expect(fixture.gate.acquisitions).toBe(0)

    const approved = await fixture.engine.renderBatch([
      {
        segmentId: 'ch10-0001',
        text: 'Approved fallback.',
        fallbackApproval: FALLBACK_APPROVAL,
      },
    ])
    const approvedResult = approved.results[0]
    if (approvedResult === undefined) throw new Error('Approved fallback result is missing')
    const manifest = JSON.parse(await readFile(approvedResult.manifestPath, 'utf8'))
    expect(manifest.renderIdentity.voice.fallbackApproval).toEqual(FALLBACK_APPROVAL)
  })

  it('maps delivery into the effective instruction and invalidates that segment', async () => {
    const fixture = await makeEngine()
    const base = {
      segmentId: 'ch11-0001',
      text: 'Delivery changes this line.',
      voiceProfileId: 'ryan-low-weary' as const,
      delivery: { emotion: 'neutral', pace: 'normal', volume: 'normal', pauseAfterMs: 0 } as const,
    }
    const first = await fixture.engine.renderBatch([base])
    const changed = await fixture.engine.renderBatch([
      { ...base, delivery: { ...base.delivery, emotion: 'weary' } },
    ])

    expect(first.results[0]?.renderIdentitySha256).not.toBe(
      changed.results[0]?.renderIdentitySha256,
    )
    expect(changed.results[0]?.status).toBe('rendered')
    const calls = await invocations(fixture.log)
    const secondSegments = calls[1]?.segments
    if (!Array.isArray(secondSegments)) throw new Error('Second invocation is missing segments')
    const secondSegment = secondSegments[0] as Record<string, unknown> | undefined
    expect(secondSegment?.effectiveInstruction).toContain('weary emotion')
  })

  it('rejects a nonempty real-smoke root before engine construction', async () => {
    const root = join(tmpdir(), `qwen-smoke-root-${crypto.randomUUID()}`)
    roots.push(root)
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'ch99-9001.wav'), 'existing canonical output')

    await expect(prepareEmptySmokeOutputRoot(root)).rejects.toThrow(/must be empty before startup/)
  })

  it('refuses stale canonical output before acquiring GPU when replacement is disabled', async () => {
    const fixture = await makeEngine('normal', {}, { allowOverwriteExisting: false })
    await writeFile(join(fixture.output, 'ch12-0001.wav'), 'existing')

    await expectCode(
      fixture.engine.renderBatch([
        {
          segmentId: 'ch12-0001',
          text: 'Never replace me.',
          voiceProfileId: 'aiden-calm-narrator',
        },
      ]),
      'configuration',
    )
    expect(fixture.gate.acquisitions).toBe(0)
  })

  it('uses atomic no-replace if a canonical smoke output races startup', async () => {
    const fixture = await makeEngine('normal', {}, { allowOverwriteExisting: false })
    const target = join(fixture.output, 'ch12-0002.wav')
    await expect(
      fixture.engine.renderBatch(
        [
          {
            segmentId: 'ch12-0002',
            text: 'A racing output must survive.',
            voiceProfileId: 'aiden-calm-narrator',
          },
        ],
        {
          onProgress: async (event) => {
            if (event.type === 'model-loaded') await writeFile(target, 'racing canonical output')
          },
        },
      ),
    ).rejects.toThrow()
    expect(await readFile(target, 'utf8')).toBe('racing canonical output')
    expect(
      (await lifecycle(fixture.lifecycleLog)).filter((item) => item === 'worker-spawned'),
    ).toHaveLength(1)
    expect(fixture.gate.releases).toBe(1)
  })

  it('rejects caller attempts to alter ambient Python import paths', async () => {
    await expect(makeEngine('normal', { PYTHONPATH: '/tmp/untrusted' })).rejects.toMatchObject({
      code: 'configuration',
    })
  })

  it('rerenders every segment when the pinned Python worker script changes', async () => {
    const fixture = await makeEngine()
    const requests: Array<SpeechSegmentRequest> = [
      {
        segmentId: 'ch13-0001',
        text: 'The worker decides this waveform.',
        voiceProfileId: 'aiden-calm-narrator',
      },
    ]
    const first = await fixture.engine.renderBatch(requests)
    expect(first.rendered).toBe(1)

    const restarted = await makeEngine('normal', {}, { reuseRoot: fixture.root })
    expect(await restarted.engine.renderBatch(requests)).toMatchObject({ rendered: 0, reused: 1 })

    // Equivalent to editing PCM scaling, the seeding order, or the generation kwargs mapping.
    await appendFile(fixture.workerScriptPath, '\n// waveform-affecting worker edit\n')
    const edited = await makeEngine('normal', {}, { reuseRoot: fixture.root })
    const afterEdit = await edited.engine.renderBatch(requests)

    expect(afterEdit).toMatchObject({ rendered: 1, reused: 0 })
    expect(afterEdit.results[0]?.status).toBe('rendered')
    expect(afterEdit.results[0]?.renderIdentitySha256).not.toBe(
      first.results[0]?.renderIdentitySha256,
    )
    const manifest = JSON.parse(
      await readFile(afterEdit.results[0]?.manifestPath ?? '', 'utf8'),
    ) as { renderIdentity: { workerRuntime: { workerSha256: string } } }
    expect(manifest.renderIdentity.workerRuntime.workerSha256).toBe(
      createHash('sha256')
        .update(await readFile(fixture.workerScriptPath))
        .digest('hex'),
    )
  })

  it('refuses unscoped segment IDs that would collide across books in the flat output root', async () => {
    const fixture = await makeEngine('normal', {}, { allowUnscopedSegmentIds: false })
    await expectCode(
      fixture.engine.renderBatch([
        {
          segmentId: 'ch03-0042',
          text: 'Two different books both use this ID.',
          voiceProfileId: 'aiden-calm-narrator',
        },
      ]),
      'configuration',
    )
    expect(fixture.gate.acquisitions).toBe(0)

    const scoped = await fixture.engine.renderBatch([
      {
        segmentId: `${BOOK}-ch0003-p000042-s0001`,
        text: 'Two different books both use this ID.',
        voiceProfileId: 'aiden-calm-narrator',
      },
    ])
    expect(scoped.rendered).toBe(1)
  })

  it('returns a completed batch and reports the failure when releasing the GPU lease fails', async () => {
    const fixture = await makeEngine()
    fixture.gate.onRelease = () => {
      throw new Error('holder required SIGKILL')
    }

    const result = await fixture.engine.renderBatch([
      {
        segmentId: 'ch14-0001',
        text: 'This batch actually rendered.',
        voiceProfileId: 'aiden-calm-narrator',
      },
    ])

    expect(result).toMatchObject({ rendered: 1, reused: 0 })
    expect(result.results[0]?.status).toBe('rendered')
    expect(result.leaseReleaseError?.message).toContain('holder required SIGKILL')
  })

  it('keeps the causative render failure when releasing the GPU lease also fails', async () => {
    const fixture = await makeEngine('wrong-hash')
    fixture.gate.onRelease = () => {
      throw new Error('holder required SIGKILL')
    }

    const error = await expectCode(
      fixture.engine.renderBatch([
        {
          segmentId: 'ch14-0002',
          text: 'The protocol error must survive.',
          voiceProfileId: 'aiden-calm-narrator',
        },
      ]),
      'protocol',
    )

    const suppressed = (error as Error & { suppressed?: Error }).suppressed
    expect(suppressed?.message).toContain('holder required SIGKILL')
  })

  it('never holds the GPU lease across a worker that is already resident, batch after batch', async () => {
    // The canonical gpu-lease enforces a total-residency ceiling when nvidia-smi cannot attribute
    // a compute process to our own tree, and our worker is spawned detached. That can only reject
    // us spuriously if a Qwen worker is ever GPU-resident at the moment acquire() is called, so
    // this pins the ordering: the lease is taken before the process exists and released only
    // after it is gone, on the renderBatch path and across a second batch that reacquires.
    const fixture = await makeEngine()
    await fixture.engine.renderBatch([
      {
        segmentId: 'ch21-0001',
        text: 'First batch takes the lease.',
        voiceProfileId: 'aiden-calm-narrator',
      },
    ])
    await fixture.engine.renderBatch([
      {
        segmentId: 'ch21-0002',
        text: 'Second batch reacquires cleanly.',
        voiceProfileId: 'ryan-low-weary',
      },
    ])

    expect(await lifecycle(fixture.lifecycleLog)).toEqual([
      'lease-acquired',
      'worker-spawned',
      'worker-exited',
      'lease-released',
      'lease-acquired',
      'worker-spawned',
      'worker-exited',
      'lease-released',
    ])
  })

  it('holds the same ordering on the application begin/render/end path', async () => {
    const fixture = await makeEngine()
    const narrator = approvedVoice('narrator-aiden', 'narrator', 'narrator')
    const adapter = new QwenApplicationSpeechEngine(fixture.engine)

    await adapter.beginBatch()
    await adapter.render({
      segment: applicationSegment(
        `${BOOK}-ch0001-p000013-s0001`,
        'The managed batch holds one lease.',
        narrator,
      ),
      voice: narrator,
      inputIdentity: 'b'.repeat(64),
    })
    await adapter.endBatch()

    expect(await lifecycle(fixture.lifecycleLog)).toEqual([
      'lease-acquired',
      'worker-spawned',
      'worker-exited',
      'lease-released',
    ])
  })

  it('releases only after a cancelled worker has exited, never while it could still be resident', async () => {
    const fixture = await makeEngine('slow-terminate')
    const controller = new AbortController()

    await expectCode(
      fixture.engine.renderBatch(
        [
          {
            segmentId: 'ch21-0003',
            text: 'Cancellation must not free the lease early.',
            voiceProfileId: 'ryan-low-weary',
          },
        ],
        {
          signal: controller.signal,
          onProgress: (event) => {
            if (event.type === 'model-loaded') controller.abort()
          },
        },
      ),
      'cancelled',
    )

    expect(await lifecycle(fixture.lifecycleLog)).toEqual([
      'lease-acquired',
      'worker-spawned',
      'worker-exited',
      'lease-released',
    ])
  })

  it('sweeps stale staging litter a SIGKILLed worker left behind, keeping live temporaries', async () => {
    const fixture = await makeEngine()
    const stale = join(fixture.output, '.book-x-ch0001-p000001-s0001.deadbeef.tmp')
    const fresh = join(fixture.output, '.book-x-ch0001-p000002-s0001.cafebabe.tmp')
    const keep = join(fixture.output, 'ch20-0001.wav')
    await Promise.all([
      writeFile(stale, 'abandoned staging bytes'),
      writeFile(fresh, 'in-flight staging bytes'),
      writeFile(keep, 'a real canonical output'),
    ])
    const old = Date.now() / 1_000 - 7_200
    await utimes(stale, old, old)

    // A second engine over the same root, as a restart after the kill would build.
    await makeEngine('normal', {}, { reuseRoot: fixture.root })

    expect(await pathPresent(stale)).toBe(false)
    expect(await pathPresent(fresh), 'a live staging file must survive').toBe(true)
    expect(await pathPresent(keep)).toBe(true)
  })
})

const approvedVoice = (
  id: string,
  role: 'narrator' | 'character' | 'fallback',
  profile: 'narrator' | 'energetic' | 'weary',
): VoiceProfile => {
  const selected = {
    narrator: {
      speaker: 'Aiden',
      instruction:
        'Speak as a calm audiobook narrator with measured pacing, clear diction, and restrained warmth.',
      seed: 9201,
    },
    energetic: {
      speaker: 'Ryan',
      instruction:
        'Speak with energetic confidence and lively momentum; alert, direct, and crisp without shouting.',
      seed: 9204,
    },
    weary: {
      speaker: 'Ryan',
      instruction:
        'Speak in a low, weary, restrained manner; tired and guarded, with slow deliberate phrasing and little emotional display.',
      seed: 9205,
    },
  }[profile]
  return new VoiceProfile({
    id,
    displayName: id,
    role,
    speakerId: role === 'character' ? id : null,
    syntheticSpeaker: selected.speaker,
    instruction: selected.instruction,
    seed: selected.seed,
    revision: 1,
  })
}

const applicationSegment = (
  id: string,
  text: string,
  voice: VoiceProfile,
  fallback = false,
): Segment => {
  const segment = new Segment({
    id,
    chapterId: `${BOOK}-ch0001`,
    sourcePassageId: `${id.slice(0, id.lastIndexOf('-s'))}`,
    order: Number(id.slice(-4)),
    sourceText: text,
    kind: voice.role === 'narrator' ? 'narration' : 'dialogue',
    speakerId: voice.speakerId,
    confidence: fallback ? 0.4 : 1,
    delivery: {
      emotion: fallback ? 'weary' : 'calm',
      pace: fallback ? 'slow' : 'normal',
      volume: 'normal',
      pauseAfterMs: 250,
    },
  })
  segment.assignVoice({
    voiceProfileId: voice.id,
    usesFallback: fallback,
    fallbackReason: fallback ? 'unresolved_speaker' : null,
  })
  return segment
}

describe('QwenApplicationSpeechEngine issue #29 port', () => {
  it('loads once across begin/render/end and maps ordered input identity, voice, delivery, and fallback', async () => {
    const fixture = await makeEngine()
    const events: SpeechProgressEvent[] = []
    const adapter = new QwenApplicationSpeechEngine(fixture.engine, {
      fallbackApprovals: [segmentApproval(`${BOOK}-ch0001-p000003-s0001`)],
      onProgress: (event) => {
        events.push(event)
      },
    })
    const narrator = approvedVoice('narrator-aiden', 'narrator', 'narrator')
    const character = approvedVoice('alice-ryan', 'character', 'energetic')
    const fallback = approvedVoice('fallback-ryan', 'fallback', 'weary')
    const requests = [
      {
        segment: applicationSegment(
          'book-0123456789abcdef01234567-ch0001-p000001-s0001',
          'The corridor remained quiet.',
          narrator,
        ),
        voice: narrator,
        inputIdentity: '1'.repeat(64),
      },
      {
        segment: applicationSegment(
          'book-0123456789abcdef01234567-ch0001-p000002-s0001',
          'We should leave right now!',
          character,
        ),
        voice: character,
        inputIdentity: '2'.repeat(64),
      },
      {
        segment: applicationSegment(
          'book-0123456789abcdef01234567-ch0001-p000003-s0001',
          'I cannot remember the way home.',
          fallback,
          true,
        ),
        voice: fallback,
        inputIdentity: '3'.repeat(64),
      },
    ] as const

    await adapter.beginBatch()
    const completed = []
    for (const request of requests) completed.push(await adapter.render(request))
    await adapter.endBatch()

    expect(adapter.identity).toMatch(/^[0-9a-f]{64}$/)
    expect(completed.map((item) => item.segmentId)).toEqual(requests.map((item) => item.segment.id))
    expect(completed.map((item) => item.inputIdentity)).toEqual(
      requests.map((item) => item.inputIdentity),
    )
    expect(completed.every((item) => item.sha256.length === 64 && item.byteLength > 44)).toBe(true)
    expect(events.filter((event) => event.type === 'model-loaded')).toHaveLength(1)
    expect(
      events
        .filter((event) => event.type === 'segment-rendered')
        .map((event) => ('segmentId' in event ? event.segmentId : null)),
    ).toEqual(requests.map((item) => item.segment.id))
    const calls = await invocations(fixture.log)
    expect(calls).toHaveLength(1)
    expect(invocationSegmentIds(calls, 0)).toEqual(requests.map((item) => item.segment.id))
    const segments = calls[0]?.segments as Array<Record<string, unknown>>
    expect(segments[2]?.fallbackApproval).toEqual(FALLBACK_APPROVAL)
    expect(segments[2]?.applicationInputIdentity).toBe(requests[2].inputIdentity)
    expect(segments[2]?.effectiveInstruction).toContain('weary emotion')
    const fallbackCompleted = completed[2]
    if (fallbackCompleted === undefined) throw new Error('Fallback application result is missing')
    const fallbackManifest = JSON.parse(
      await readFile(fallbackCompleted.wavPath.replace(/\.wav$/u, '.render.json'), 'utf8'),
    )
    expect(fallbackManifest.renderIdentity.applicationInputIdentity).toBe(requests[2].inputIdentity)
    expect(fixture.gate.acquisitions).toBe(1)
    expect(fixture.gate.releases).toBe(1)
  })

  it('retries through application begin/render/end and retains the replacement session', async () => {
    const fixture = await makeEngine('health-gate-once')
    const events: SpeechProgressEvent[] = []
    const adapter = new QwenApplicationSpeechEngine(fixture.engine, {
      onProgress: (event) => {
        events.push(event)
      },
    })
    const narrator = approvedVoice('narrator-aiden', 'narrator', 'narrator')
    const firstId = `${BOOK}-ch0001-p000014-s0001`
    const laterId = `${BOOK}-ch0001-p000015-s0001`

    await adapter.beginBatch()
    const first = await adapter.render({
      segment: applicationSegment(firstId, 'Synthetic managed retry fixture.', narrator),
      voice: narrator,
      inputIdentity: 'c'.repeat(64),
    })
    const later = await adapter.render({
      segment: applicationSegment(laterId, 'Synthetic retained replacement fixture.', narrator),
      voice: narrator,
      inputIdentity: 'd'.repeat(64),
    })
    await adapter.endBatch()

    const calls = await invocations(fixture.log)
    const config = await loadProductionConfig(PRODUCTION_CONFIG)
    const profile = config.selectedProfiles.get('aiden-calm-narrator')
    if (profile === undefined) throw new Error('Pinned narrator profile is missing')
    const firstWorkerSegments = calls[0]?.segments
    const replacementSegments = calls[1]?.segments
    if (!Array.isArray(firstWorkerSegments) || !Array.isArray(replacementSegments)) {
      throw new Error('Managed retry invocations are missing segments')
    }
    const firstWorkerSegment = firstWorkerSegments[0] as Record<string, unknown> | undefined
    expect(first.segmentId).toBe(firstId)
    expect(later.segmentId).toBe(laterId)
    expect(calls).toHaveLength(2)
    expect(invocationSegmentIds(calls, 0)).toEqual([firstId])
    expect(invocationSegmentIds(calls, 1)).toEqual([firstId, laterId])
    expect(firstWorkerSegment?.seed).toBe(deriveSeed(profile, firstId, 1))
    expect(replacementSegments[0]?.seed).toBe(deriveSeed(profile, firstId, 2))
    expect(
      events
        .filter((event) => event.type === 'segment-rendered')
        .map((event) => ('segmentId' in event ? event.segmentId : null)),
    ).toEqual([firstId, laterId])
    expect(fixture.gate.acquisitions).toBe(1)
    expect(fixture.gate.releases).toBe(1)
    expect(await lifecycle(fixture.lifecycleLog)).toEqual([
      'lease-acquired',
      'worker-spawned',
      'worker-exited',
      'worker-spawned',
      'worker-exited',
      'lease-released',
    ])
  })

  it('recovers an orphaned salted artifact through the managed adapter without rerendering', async () => {
    const fixture = await makeEngine('health-gate-once')
    const narrator = approvedVoice('narrator-aiden', 'narrator', 'narrator')
    const segmentId = `${BOOK}-ch0001-p000016-s0001`
    const request = {
      segment: applicationSegment(
        segmentId,
        'Synthetic orphaned salted artifact fixture.',
        narrator,
      ),
      voice: narrator,
      inputIdentity: 'e'.repeat(64),
    }
    const firstAdapter = new QwenApplicationSpeechEngine(fixture.engine)
    await firstAdapter.beginBatch()
    const rendered = await firstAdapter.render(request)
    await firstAdapter.endBatch()
    expect(await invocations(fixture.log)).toHaveLength(2)

    const restarted = await makeEngine('normal', {}, { reuseRoot: fixture.root })
    const events: SpeechProgressEvent[] = []
    const resumedAdapter = new QwenApplicationSpeechEngine(restarted.engine, {
      onProgress: (event) => {
        events.push(event)
      },
    })
    await resumedAdapter.beginBatch()
    const recovered = await resumedAdapter.render(request)
    await resumedAdapter.endBatch()

    expect(recovered).toEqual(rendered)
    const calls = await invocations(fixture.log)
    expect(calls).toHaveLength(3)
    expect(invocationSegmentIds(calls, 2)).toEqual([])
    expect(
      events
        .filter((event) => event.type === 'segment-reused')
        .map((event) => ('segmentId' in event ? event.segmentId : null)),
    ).toEqual([segmentId])
    expect(restarted.gate.acquisitions).toBe(1)
    expect(restarted.gate.releases).toBe(1)
  })

  it('rejects fallback application renders without an explicit approval record', async () => {
    const fixture = await makeEngine()
    const fallback = approvedVoice('fallback-ryan', 'fallback', 'weary')
    const adapter = new QwenApplicationSpeechEngine(fixture.engine)
    await adapter.beginBatch()
    await expect(
      adapter.render({
        segment: applicationSegment(
          `${BOOK}-ch0001-p000004-s0001`,
          'Who is speaking?',
          fallback,
          true,
        ),
        voice: fallback,
        inputIdentity: '4'.repeat(64),
      }),
    ).rejects.toThrow(/no explicit human approval/)
    await adapter.endBatch()
  })

  it('refuses to substitute a different approved voice for the configured fallback', async () => {
    const fixture = await makeEngine()
    // The human approved Ryan energetic for this unresolved speaker, but the adapter can only
    // render the configured ryan-low-weary fallback.
    const fallback = approvedVoice('fallback-ryan', 'fallback', 'energetic')
    const segmentId = `${BOOK}-ch0001-p000005-s0001`
    const adapter = new QwenApplicationSpeechEngine(fixture.engine, {
      fallbackApprovals: [segmentApproval(segmentId)],
    })
    await adapter.beginBatch()

    const error = await expectCode(
      adapter.render({
        segment: applicationSegment(segmentId, 'A different voice was approved.', fallback, true),
        voice: fallback,
        inputIdentity: '5'.repeat(64),
      }),
      'configuration',
    )

    expect(error.message).toContain('ryan-energetic-baseline')
    expect(error.message).toContain('ryan-low-weary')
    await adapter.endBatch()
    // Nothing was voiced with a profile the human never approved.
    expect((await invocations(fixture.log))[0]?.segments).toEqual([])
  })

  it('gates every unresolved speaker separately instead of once per batch', async () => {
    const fixture = await makeEngine()
    const fallback = approvedVoice('fallback-ryan', 'fallback', 'weary')
    const approved = `${BOOK}-ch0001-p000006-s0001`
    const unapproved = `${BOOK}-ch0001-p000007-s0001`
    const adapter = new QwenApplicationSpeechEngine(fixture.engine, {
      fallbackApprovals: [segmentApproval(approved)],
    })
    await adapter.beginBatch()

    const rendered = await adapter.render({
      segment: applicationSegment(approved, 'The approved speaker talks.', fallback, true),
      voice: fallback,
      inputIdentity: '6'.repeat(64),
    })
    expect(rendered.segmentId).toBe(approved)

    // A second unresolved speaker is not covered by the first speaker's decision.
    await expect(
      adapter.render({
        segment: applicationSegment(unapproved, 'A different speaker talks.', fallback, true),
        voice: fallback,
        inputIdentity: '7'.repeat(64),
      }),
    ).rejects.toThrow(/no explicit human approval/)
    await adapter.endBatch()

    const segments = (await invocations(fixture.log))[0]?.segments as
      | Array<Record<string, unknown>>
      | undefined
    expect(segments?.map((item) => item.segmentId)).toEqual([approved])
  })

  it('rejects an approval recorded against a different speaker decision', async () => {
    const fixture = await makeEngine()
    const fallback = approvedVoice('fallback-ryan', 'fallback', 'weary')
    const segmentId = `${BOOK}-ch0001-p000008-s0001`
    const adapter = new QwenApplicationSpeechEngine(fixture.engine, {
      fallbackApprovals: [
        segmentApproval(segmentId, { speakerId: 'alice', fallbackReason: 'missing_speaker_voice' }),
      ],
    })
    await adapter.beginBatch()

    await expect(
      adapter.render({
        segment: applicationSegment(segmentId, 'Whose decision was this?', fallback, true),
        voice: fallback,
        inputIdentity: '8'.repeat(64),
      }),
    ).rejects.toThrow(/does not match its unresolved speaker decision/)
    await adapter.endBatch()
  })

  it('binds each approval into its own segment manifest without moving the adapter identity', async () => {
    const fixture = await makeEngine()
    const segmentId = `${BOOK}-ch0001-p000009-s0001`
    const base = new QwenApplicationSpeechEngine(fixture.engine, {
      fallbackApprovals: [segmentApproval(segmentId)],
    })
    // Approvals arrive incrementally as the reviewer works through chapters. A growing catalog
    // must not move the adapter identity: issue #29 folds it into every segment's inputIdentity
    // and into the job command identity, so that would re-render the whole book per approval
    // click and stale the running job. Per-approval invalidation lives in the segment manifest.
    const grown = new QwenApplicationSpeechEngine(fixture.engine, {
      fallbackApprovals: [
        segmentApproval(segmentId),
        segmentApproval(`${BOOK}-ch0001-p000010-s0001`, { approvalId: 'review-fallback-0002' }),
        segmentApproval(`${BOOK}-ch0001-p000011-s0001`, { approvalId: 'review-fallback-0003' }),
      ],
    })
    const none = new QwenApplicationSpeechEngine(fixture.engine)
    expect(grown.identity).toBe(base.identity)
    expect(none.identity).toBe(base.identity)

    const fallback = approvedVoice('fallback-ryan', 'fallback', 'weary')
    await base.beginBatch()
    const completed = await base.render({
      segment: applicationSegment(segmentId, 'One approved unresolved speaker.', fallback, true),
      voice: fallback,
      inputIdentity: '9'.repeat(64),
    })
    await base.endBatch()

    const manifestPath = completed.wavPath.replace(/\.wav$/u, '.render.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      renderIdentity: { voice: { fallbackApproval: unknown } }
    }
    expect(manifest.renderIdentity.voice.fallbackApproval).toEqual(FALLBACK_APPROVAL)

    // Narrow invalidation still works: revising this segment's own decision restales this
    // segment. That is the granularity the global catalog hash was redundantly duplicating.
    const revised = segmentApproval(segmentId, { approvalId: 'review-fallback-0009' })
    const reapproved = new QwenApplicationSpeechEngine(fixture.engine, {
      fallbackApprovals: [revised],
    })
    await reapproved.beginBatch()
    await reapproved.render({
      segment: applicationSegment(segmentId, 'One approved unresolved speaker.', fallback, true),
      voice: fallback,
      inputIdentity: '9'.repeat(64),
    })
    await reapproved.endBatch()

    const calls = await invocations(fixture.log)
    expect(
      invocationSegmentIds(calls, 1),
      'a revised approval must restale its own segment',
    ).toEqual([segmentId])
    const rerendered = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      renderIdentity: { voice: { fallbackApproval: { approvalId: string } } }
    }
    expect(rerendered.renderIdentity.voice.fallbackApproval.approvalId).toBe(revised.approvalId)
  })

  it('completes endBatch and reports the failure when releasing the GPU lease fails', async () => {
    const fixture = await makeEngine()
    const events: SpeechProgressEvent[] = []
    fixture.gate.onRelease = () => {
      throw new Error('holder required SIGKILL')
    }
    const narrator = approvedVoice('narrator-aiden', 'narrator', 'narrator')
    const adapter = new QwenApplicationSpeechEngine(fixture.engine, {
      onProgress: (event) => {
        events.push(event)
      },
    })

    await adapter.beginBatch()
    const completed = await adapter.render({
      segment: applicationSegment(
        `${BOOK}-ch0001-p000012-s0001`,
        'This audio is finished and saved.',
        narrator,
      ),
      voice: narrator,
      inputIdentity: 'a'.repeat(64),
    })
    // The audio all rendered, so a lease that would not release must not fail the job.
    await expect(adapter.endBatch()).resolves.toBeUndefined()

    expect(completed.byteLength).toBeGreaterThan(44)
    const reported = events.filter((event) => event.type === 'lease-release-failed')
    expect(reported).toHaveLength(1)
    expect(reported[0]).toMatchObject({
      message: expect.stringContaining('holder required SIGKILL'),
    })
  })

  it('reports a cancelled batch as cancelled rather than a worker crash', async () => {
    const cancelLog = join(tmpdir(), `qwen-tts-app-cancel-${crypto.randomUUID()}.log`)
    roots.push(cancelLog)
    const fixture = await makeEngine('hang', { FAKE_QWEN_CANCEL_LOG: cancelLog })
    const controller = new AbortController()
    const adapter = new QwenApplicationSpeechEngine(fixture.engine, { signal: controller.signal })
    await adapter.beginBatch()

    controller.abort()
    // Wait for the child to actually exit so endBatch takes the already-closed path.
    for (let waited = 0; waited < 5_000; waited += 25) {
      const log = await readFile(cancelLog, 'utf8').catch(() => '')
      if (log.includes('term-exit')) break
      await delay(25)
    }
    await delay(100)

    const error = await expectCode(adapter.endBatch(), 'cancelled')
    expect(error.message).not.toContain('exited before clean completion')
    expect(fixture.gate.releases).toBe(1)
  })
})
