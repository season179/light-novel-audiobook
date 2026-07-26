import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { SelectedVoiceProfileId } from './types.js'
import { SpeechEngineError } from './types.js'

const SHA256 = /^[0-9a-f]{64}$/

export interface VoiceProfile {
  readonly id: SelectedVoiceProfileId
  readonly role: string
  readonly speaker: 'Aiden' | 'Ryan'
  readonly instruction: string
  readonly instructionSha256: string
  readonly seedSalt: number
  readonly listeningEvidenceOutputSha256: string
}

export interface GenerationSettings {
  readonly language: 'English'
  readonly doSample: true
  readonly topK: 50
  readonly topP: 1
  readonly temperature: 0.9
  readonly repetitionPenalty: 1.05
  readonly subtalkerDoSample: true
  readonly subtalkerTopK: 50
  readonly subtalkerTopP: 1
  readonly subtalkerTemperature: 0.9
  readonly maxNewTokens: 8192
  readonly nonStreamingMode: true
}

export interface WavRequirements {
  readonly container: 'RIFF/WAVE'
  readonly encoding: 'PCM'
  readonly sampleRateHz: 24000
  readonly channels: 1
  readonly bitsPerSample: 16
  readonly maximumClippedSampleFraction: number
  readonly minimumActiveFrameFraction: number
  readonly minimumSecondsPerWord: number
  readonly maximumSecondsPerWord: number
  /** Calibrated upper-envelope allowance for fixed per-utterance duration variance (#91). */
  readonly fixedUtteranceOverheadSeconds: number
  readonly maximumDurationSeconds: number
}

export interface QwenProductionConfig {
  readonly schemaVersion: 1
  readonly adapter: {
    readonly id: 'qwen3-tts-python-batch'
    readonly version: 1
    readonly protocolVersion: 1
  }
  readonly model: {
    readonly repository: 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice'
    readonly revision: '0c0e3051f131929182e2c023b9537f8b1c68adfe'
    readonly snapshotLockSha256: string
    readonly mainWeightsSha256: string
    readonly speechTokenizerWeightsSha256: string
  }
  readonly runtime: {
    readonly python: '3.12.13'
    readonly package: 'qwen-tts'
    readonly version: '0.1.1'
    readonly torch: '2.9.1'
    readonly torchaudio: '2.9.1'
    readonly uvLockSha256: string
    readonly attentionImplementation: 'sdpa'
    readonly flashAttentionAllowed: false
    readonly offline: true
    readonly referenceAudioAllowed: false
  }
  readonly generation: GenerationSettings
  readonly wav: WavRequirements
  readonly voiceProfiles: ReadonlyArray<VoiceProfile>
  readonly fallbackVoiceProfileId: SelectedVoiceProfileId
  readonly seedStrategy: 'sha256-profile-segment-v1'
  readonly evidence: {
    readonly humanListeningPath: string
    readonly humanListeningFileSha256: string
  }
}

export interface LoadedProductionConfig {
  readonly value: QwenProductionConfig
  readonly sha256: string
  readonly profiles: ReadonlyMap<SelectedVoiceProfileId, VoiceProfile>
}

function fail(message: string): never {
  throw new SpeechEngineError('configuration', `Invalid Qwen production configuration: ${message}`)
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail(`${name} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(
  value: Record<string, unknown>,
  keys: ReadonlyArray<string>,
  name: string,
): void {
  if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0'))
    fail(`${name} has unexpected fields`)
}

function expectLocked(value: unknown, expected: unknown, name: string): void {
  if (value !== expected) fail(`${name} is not pinned`)
}

function expectSha(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(`${name} must be a SHA-256`)
}

function validateConfig(value: unknown): QwenProductionConfig {
  const root = record(value, 'root')
  exactKeys(
    root,
    [
      'schemaVersion',
      'adapter',
      'model',
      'runtime',
      'generation',
      'wav',
      'voiceProfiles',
      'fallbackVoiceProfileId',
      'seedStrategy',
      'evidence',
    ],
    'root',
  )
  expectLocked(root.schemaVersion, 1, 'schemaVersion')

  const adapter = record(root.adapter, 'adapter')
  exactKeys(adapter, ['id', 'version', 'protocolVersion'], 'adapter')
  expectLocked(adapter.id, 'qwen3-tts-python-batch', 'adapter.id')
  expectLocked(adapter.version, 1, 'adapter.version')
  expectLocked(adapter.protocolVersion, 1, 'adapter.protocolVersion')

  const model = record(root.model, 'model')
  exactKeys(
    model,
    [
      'repository',
      'revision',
      'snapshotLockSha256',
      'mainWeightsSha256',
      'speechTokenizerWeightsSha256',
    ],
    'model',
  )
  expectLocked(model.repository, 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice', 'model.repository')
  expectLocked(model.revision, '0c0e3051f131929182e2c023b9537f8b1c68adfe', 'model.revision')
  expectLocked(
    model.snapshotLockSha256,
    '52eb83769efd950f0fbc0d7936db0e3381b133582e2a405f8f074f4458670d27',
    'model.snapshotLockSha256',
  )
  expectLocked(
    model.mainWeightsSha256,
    '38b1d5971bdbd982b561cccec982669a53b0537c3cf5e9bd4778ed07bb2f5137',
    'model.mainWeightsSha256',
  )
  expectLocked(
    model.speechTokenizerWeightsSha256,
    '836b7b357f5ea43e889936a3709af68dfe3751881acefe4ecf0dbd30ba571258',
    'model.speechTokenizerWeightsSha256',
  )

  const runtime = record(root.runtime, 'runtime')
  const runtimeLocks = {
    python: '3.12.13',
    package: 'qwen-tts',
    version: '0.1.1',
    torch: '2.9.1',
    torchaudio: '2.9.1',
    uvLockSha256: '6a7d989924871b408ed0e6eea86ce21ff399033e1272c5fa19bf9a5e38c3bbd9',
    attentionImplementation: 'sdpa',
    flashAttentionAllowed: false,
    offline: true,
    referenceAudioAllowed: false,
  } as const
  exactKeys(runtime, Object.keys(runtimeLocks), 'runtime')
  for (const [key, expected] of Object.entries(runtimeLocks))
    expectLocked(runtime[key], expected, `runtime.${key}`)

  const generation = record(root.generation, 'generation')
  const generationLocks = {
    language: 'English',
    doSample: true,
    topK: 50,
    topP: 1,
    temperature: 0.9,
    repetitionPenalty: 1.05,
    subtalkerDoSample: true,
    subtalkerTopK: 50,
    subtalkerTopP: 1,
    subtalkerTemperature: 0.9,
    maxNewTokens: 8192,
    nonStreamingMode: true,
  } as const
  exactKeys(generation, Object.keys(generationLocks), 'generation')
  for (const [key, expected] of Object.entries(generationLocks))
    expectLocked(generation[key], expected, `generation.${key}`)

  const wav = record(root.wav, 'wav')
  exactKeys(
    wav,
    [
      'container',
      'encoding',
      'sampleRateHz',
      'channels',
      'bitsPerSample',
      'maximumClippedSampleFraction',
      'minimumActiveFrameFraction',
      'minimumSecondsPerWord',
      'maximumSecondsPerWord',
      'fixedUtteranceOverheadSeconds',
      'maximumDurationSeconds',
    ],
    'wav',
  )
  expectLocked(wav.container, 'RIFF/WAVE', 'wav.container')
  expectLocked(wav.encoding, 'PCM', 'wav.encoding')
  expectLocked(wav.sampleRateHz, 24_000, 'wav.sampleRateHz')
  expectLocked(wav.channels, 1, 'wav.channels')
  expectLocked(wav.bitsPerSample, 16, 'wav.bitsPerSample')
  const wavGateLocks = {
    maximumClippedSampleFraction: 0.001,
    minimumActiveFrameFraction: 0.15,
    minimumSecondsPerWord: 0.08,
    maximumSecondsPerWord: 2,
    // 38 measured short renders: 2.64 s shipped-voice maximum; 3.00 s ceiling leaves
    // 0.36 s safety margin while retaining a full second of separation from the 4 s runaway probe.
    fixedUtteranceOverheadSeconds: 1,
    maximumDurationSeconds: 30,
  } as const
  for (const [key, expected] of Object.entries(wavGateLocks))
    expectLocked(wav[key], expected, `wav.${key}`)

  if (!Array.isArray(root.voiceProfiles) || root.voiceProfiles.length !== 3)
    fail('exactly three selected voice profiles are required')
  const profileLocks = [
    {
      id: 'aiden-calm-narrator',
      role: 'narrator',
      speaker: 'Aiden',
      instruction:
        'Speak as a calm audiobook narrator with measured pacing, clear diction, and restrained warmth.',
      instructionSha256: '89ab750b6aca87f33cf45bb27853af5558244756b7a71c2397e73715aed32569',
      seedSalt: 9201,
      listeningEvidenceOutputSha256:
        '14f815c1d532d6e331e7817bb5b11ef5cd1a4b4e8897fc1ed046a596f523ffb5',
    },
    {
      id: 'ryan-energetic-baseline',
      role: 'character',
      speaker: 'Ryan',
      instruction:
        'Speak with energetic confidence and lively momentum; alert, direct, and crisp without shouting.',
      instructionSha256: 'd183f94963e48d47d999ea3411ef12fb973f4a66b7e2def5f6b22d9525da99c0',
      seedSalt: 9204,
      listeningEvidenceOutputSha256:
        'e77c6eab20bb2302579cfcb7834fe02dc710224c6d913e975f3cda5a003c7db3',
    },
    {
      id: 'ryan-low-weary',
      role: 'character-or-fallback',
      speaker: 'Ryan',
      instruction:
        'Speak in a low, weary, restrained manner; tired and guarded, with slow deliberate phrasing and little emotional display.',
      instructionSha256: '5d1475b3120ef90869104a7a9b355105050486ce5bf053427e38e2b159f34ba1',
      seedSalt: 9205,
      listeningEvidenceOutputSha256:
        'a0fc1f5663f56d23b045b25a98c52ecd7ac45eed7d630db3b8fd902569841759',
    },
  ] as const
  root.voiceProfiles.forEach((item, index) => {
    const profile = record(item, `voiceProfiles[${index}]`)
    exactKeys(
      profile,
      [
        'id',
        'role',
        'speaker',
        'instruction',
        'instructionSha256',
        'seedSalt',
        'listeningEvidenceOutputSha256',
      ],
      `voiceProfiles[${index}]`,
    )
    const expected = profileLocks[index]
    if (!expected) fail('voice profile lock is missing')
    for (const [key, expectedValue] of Object.entries(expected))
      expectLocked(profile[key], expectedValue, `voiceProfiles[${index}].${key}`)
    expectSha(profile.instructionSha256, 'voice instruction hash')
    const actualInstructionHash = createHash('sha256')
      .update(profile.instruction as string)
      .digest('hex')
    if (actualInstructionHash !== profile.instructionSha256)
      fail('voice instruction hash does not match')
    expectSha(profile.listeningEvidenceOutputSha256, 'listening evidence output hash')
  })

  expectLocked(root.fallbackVoiceProfileId, 'ryan-low-weary', 'fallbackVoiceProfileId')
  expectLocked(root.seedStrategy, 'sha256-profile-segment-v1', 'seedStrategy')
  const evidence = record(root.evidence, 'evidence')
  exactKeys(evidence, ['humanListeningPath', 'humanListeningFileSha256'], 'evidence')
  expectLocked(
    evidence.humanListeningPath,
    'docs/evidence/issue-8-qwen3-tts-human-listening-2026-07-25.json',
    'evidence.humanListeningPath',
  )
  expectLocked(
    evidence.humanListeningFileSha256,
    'db2a3fdae8b6d9989bd261007f53c8cd5c77a61cee8510b6f1fa025a133d67d7',
    'evidence.humanListeningFileSha256',
  )
  expectSha(evidence.humanListeningFileSha256, 'human listening evidence hash')

  return root as unknown as QwenProductionConfig
}

export async function loadProductionConfig(path: string): Promise<LoadedProductionConfig> {
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch (error) {
    throw new SpeechEngineError(
      'configuration',
      `Cannot read Qwen production configuration: ${path}`,
      { cause: error },
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new SpeechEngineError(
      'configuration',
      'Qwen production configuration is not valid JSON',
      { cause: error },
    )
  }
  const value = validateConfig(parsed)
  return {
    value,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    profiles: new Map(value.voiceProfiles.map((profile) => [profile.id, profile])),
  }
}
