import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Segment, VoiceProfile } from '@light-novel-audiobook/domain'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type ExclusiveGpuGate,
  type GpuLease,
  type GpuOwner,
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

const FALLBACK_APPROVAL = {
  approvalId: 'review-fallback-0001',
  approvalSha256: 'a'.repeat(64),
} as const

class RecordingGpuGate implements ExclusiveGpuGate {
  acquisitions = 0
  releases = 0
  onRelease: (() => void | Promise<void>) | undefined

  async acquire(owner: GpuOwner, signal?: AbortSignal): Promise<GpuLease> {
    if (signal?.aborted) throw new Error('aborted')
    this.acquisitions += 1
    let released = false
    return {
      owner,
      lockFilePath: '/fixture/gpu.lock',
      release: async () => {
        if (!released) {
          await this.onRelease?.()
          this.releases += 1
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
  } = {},
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
  await Promise.all([mkdir(output, { recursive: true }), mkdir(snapshot, { recursive: true })])
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
    ...engineOptions,
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
    const { engine, log, gate, root } = await makeEngine()
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
        .update(await readFile(FAKE_WORKER))
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
  })

  it('rejects caller attempts to alter ambient Python import paths', async () => {
    await expect(makeEngine('normal', { PYTHONPATH: '/tmp/untrusted' })).rejects.toMatchObject({
      code: 'configuration',
    })
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
    chapterId: 'book-0123456789abcdef01234567-ch0001',
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
      fallbackApproval: FALLBACK_APPROVAL,
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

  it('rejects fallback application renders without an explicit approval record', async () => {
    const fixture = await makeEngine()
    const fallback = approvedVoice('fallback-ryan', 'fallback', 'weary')
    const adapter = new QwenApplicationSpeechEngine(fixture.engine)
    await adapter.beginBatch()
    await expect(
      adapter.render({
        segment: applicationSegment(
          'book-0123456789abcdef01234567-ch0001-p000004-s0001',
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
})
