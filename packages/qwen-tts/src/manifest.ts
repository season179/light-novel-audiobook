import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { LoadedProductionConfig, VoiceProfile, WavRequirements } from './config.js'
import type { QwenWorkerRuntimeIdentity } from './runtime-identity.js'
import type {
  FallbackApproval,
  SpeechAudioIdentity,
  SpeechDeliveryDirection,
  SpeechSegmentRequest,
  SpeechSegmentResult,
} from './types.js'
import { SpeechEngineError } from './types.js'
import { readCanonicalWavHeader, validateCanonicalWav } from './wav.js'

const SHA256 = /^[0-9a-f]{64}$/

/**
 * One narrowly pinned reuse migration for #91. The predecessor worker differs only in its WAV
 * pacing validator and produced byte-identical waveforms under the same render identity inputs.
 * Its persisted clips passed the stricter zero-intercept gate, so rerendering them would waste the
 * GPU without improving safety. Both sides are content-addressed so a future worker/config edit
 * automatically falls back to normal exact-identity invalidation.
 */
const AFFINE_WAV_GATE_REUSE_MIGRATION = Object.freeze({
  predecessorProductionConfigSha256:
    '82f9a62a94a62bcf68e5d35709e358ffb552e380d1295a8e7b014dc82a219f25',
  predecessorWorkerSha256: '966d089fc0a65d63bcdd6a3d99f6baebd32e93bf054d0d67aa6f2b4050f02ca7',
  successorProductionConfigSha256:
    'e547bfa62f1e63dd801ecb9daa7673c5f3fb751a2ef6cf2e8df45ad80253d1f7',
  successorWorkerSha256: '652435317efee85e6e5ceb6e4e4d02f30339fbf7ebceffbbd2c56b906dc6fcfb',
})

export interface RenderIdentity {
  readonly adapter: LoadedProductionConfig['value']['adapter']
  readonly model: LoadedProductionConfig['value']['model']
  readonly runtime: LoadedProductionConfig['value']['runtime']
  /**
   * Live pinned worker/interpreter identity. `runtime` above is a hardcoded lock and can never
   * vary, so only this binds the actual waveform-producing code to the reuse decision.
   */
  readonly workerRuntime: QwenWorkerRuntimeIdentity
  readonly text: { readonly value: string; readonly sha256: string }
  readonly applicationInputIdentity: string | null
  readonly voice: VoiceProfile & {
    readonly usedFallback: boolean
    readonly fallbackApproval: FallbackApproval | null
    readonly effectiveInstruction: string
    readonly effectiveInstructionSha256: string
  }
  readonly delivery: SpeechDeliveryDirection
  readonly settings: LoadedProductionConfig['value']['generation'] & {
    readonly seed: number
    readonly seedStrategy: LoadedProductionConfig['value']['seedStrategy']
  }
}

export interface SegmentPlan {
  readonly sequence: number
  readonly request: SpeechSegmentRequest
  readonly profile: VoiceProfile
  readonly usedFallback: boolean
  readonly delivery: SpeechDeliveryDirection
  readonly effectiveInstruction: string
  readonly seed: number
  readonly wavPath: string
  readonly manifestPath: string
  readonly identity: RenderIdentity
  readonly identitySha256: string
}

interface RenderManifest {
  readonly schemaVersion: 1
  readonly segmentId: string
  readonly observedProductionConfigSha256: string
  readonly renderIdentitySha256: string
  readonly renderIdentity: RenderIdentity
  readonly audio: SpeechSegmentResult['audio'] & { readonly file: string }
  readonly createdAt: string
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export const DEFAULT_DELIVERY: SpeechDeliveryDirection = Object.freeze({
  emotion: 'neutral',
  pace: 'normal',
  volume: 'normal',
  pauseAfterMs: 0,
})

export function effectiveInstruction(
  profile: VoiceProfile,
  delivery: SpeechDeliveryDirection,
): string {
  return `${profile.instruction} For this segment, use ${delivery.emotion} emotion, ${delivery.pace} pacing, and ${delivery.volume} volume while preserving the approved voice.`
}

export function deriveSeed(profile: VoiceProfile, segmentId: string): number {
  const digest = createHash('sha256')
    .update(`${profile.id}\0${profile.seedSalt}\0${segmentId}`)
    .digest()
  return Math.max(1, digest.readUInt32BE(0) & 0x7fffffff)
}

export function createSegmentPlan(
  sequence: number,
  request: SpeechSegmentRequest,
  outputDirectory: string,
  config: LoadedProductionConfig,
  runtimeIdentity: QwenWorkerRuntimeIdentity,
): SegmentPlan {
  const usedFallback = request.voiceProfileId === undefined
  const profileId = request.voiceProfileId ?? config.value.fallbackVoiceProfileId
  const profile = config.profiles.get(profileId)
  if (!profile) throw new Error(`Missing configured voice profile: ${profileId}`)
  const seed = deriveSeed(profile, request.segmentId)
  const delivery = request.delivery ?? DEFAULT_DELIVERY
  const instruction = effectiveInstruction(profile, delivery)
  const identity: RenderIdentity = {
    adapter: config.value.adapter,
    model: config.value.model,
    runtime: config.value.runtime,
    workerRuntime: runtimeIdentity,
    text: { value: request.text, sha256: sha256(request.text) },
    applicationInputIdentity: request.applicationInputIdentity ?? null,
    voice: {
      ...profile,
      usedFallback,
      fallbackApproval: request.fallbackApproval ?? null,
      effectiveInstruction: instruction,
      effectiveInstructionSha256: sha256(instruction),
    },
    delivery,
    settings: {
      ...config.value.generation,
      seed,
      seedStrategy: config.value.seedStrategy,
    },
  }
  return {
    sequence,
    request,
    profile,
    usedFallback,
    delivery,
    effectiveInstruction: instruction,
    seed,
    wavPath: join(outputDirectory, `${request.segmentId}.wav`),
    manifestPath: join(outputDirectory, `${request.segmentId}.render.json`),
    identity,
    identitySha256: sha256(canonicalJson(identity)),
  }
}

function unreadable(label: string, path: string, segmentId: string, cause: unknown): never {
  throw new SpeechEngineError(
    'audio-validation',
    `Cannot read cached ${label} for ${segmentId}: ${path}`,
    { cause, segmentId },
  )
}

/**
 * Reads a cached artifact, rejecting anything that is not a plain regular file. A vanished file
 * simply invalidates reuse; every other error (EIO, EACCES on the file *or* its directory) is
 * surfaced so a failing disk never masquerades as a stale segment and triggers a needless GPU
 * re-render of the whole book.
 */
async function readCached(
  path: string,
  label: string,
  segmentId: string,
): Promise<Buffer | undefined> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) return undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    unreadable(label, path, segmentId, error)
  }
  try {
    return await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    unreadable(label, path, segmentId, error)
  }
}

/**
 * The audio identity the manifest claims. Nothing here is trusted on its own: it is only usable
 * once the bytes on disk hash to `sha256` and their own canonical header derives the same shape.
 */
interface RecordedAudioClaim {
  readonly sha256: string
  readonly bytes: number
  readonly frames: number
  readonly durationSeconds: number
}

function recordedAudioClaim(
  manifest: RenderManifest,
  requirements: WavRequirements,
): RecordedAudioClaim | undefined {
  const audio = manifest.audio as Partial<SpeechAudioIdentity> | undefined
  if (audio === undefined) return undefined
  const { sha256: digest, bytes, frames, durationSeconds } = audio
  if (
    typeof digest !== 'string' ||
    !SHA256.test(digest) ||
    typeof bytes !== 'number' ||
    typeof frames !== 'number' ||
    typeof durationSeconds !== 'number' ||
    !Number.isSafeInteger(frames) ||
    frames <= 0 ||
    audio.sampleRateHz !== requirements.sampleRateHz ||
    audio.channels !== requirements.channels ||
    audio.bitsPerSample !== requirements.bitsPerSample
  ) {
    return undefined
  }
  return { sha256: digest, bytes, frames, durationSeconds }
}

function matchesRenderIdentity(
  manifest: RenderManifest,
  plan: SegmentPlan,
  config: LoadedProductionConfig,
): boolean {
  if (
    manifest.renderIdentitySha256 === plan.identitySha256 &&
    canonicalJson(manifest.renderIdentity) === canonicalJson(plan.identity)
  ) {
    return true
  }
  const migration = AFFINE_WAV_GATE_REUSE_MIGRATION
  if (
    config.sha256 !== migration.successorProductionConfigSha256 ||
    plan.identity.workerRuntime.workerSha256 !== migration.successorWorkerSha256 ||
    manifest.observedProductionConfigSha256 !== migration.predecessorProductionConfigSha256
  ) {
    return false
  }
  const predecessorIdentity: RenderIdentity = {
    ...plan.identity,
    workerRuntime: {
      ...plan.identity.workerRuntime,
      workerSha256: migration.predecessorWorkerSha256,
    },
  }
  return (
    manifest.renderIdentitySha256 === sha256(canonicalJson(predecessorIdentity)) &&
    canonicalJson(manifest.renderIdentity) === canonicalJson(predecessorIdentity)
  )
}

export async function tryReuse(
  plan: SegmentPlan,
  config: LoadedProductionConfig,
): Promise<SpeechSegmentResult | undefined> {
  const manifestBytes = await readCached(
    plan.manifestPath,
    'render manifest',
    plan.request.segmentId,
  )
  if (manifestBytes === undefined) return undefined
  let manifest: RenderManifest
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8')) as RenderManifest
  } catch {
    return undefined
  }
  if (
    manifest.schemaVersion !== 1 ||
    manifest.segmentId !== plan.request.segmentId ||
    !matchesRenderIdentity(manifest, plan, config) ||
    manifest.audio?.file !== `${plan.request.segmentId}.wav`
  ) {
    return undefined
  }
  const claim = recordedAudioClaim(manifest, config.value.wav)
  if (claim === undefined) return undefined
  const bytes = await readCached(plan.wavPath, 'WAV', plan.request.segmentId)
  if (bytes === undefined) return undefined
  if (bytes.length !== claim.bytes || sha256(bytes) !== claim.sha256) return undefined
  // A matching content address only proves the bytes are unchanged, not that they are audio.
  // Re-derive the shape from the file's own canonical header so a manifest written by anything
  // other than recordRendered can never pass non-audio off as a finished clip. This is a constant
  // number of buffer reads; the deep per-sample health gate stays on the render path only.
  const header = readCanonicalWavHeader(bytes, config.value.wav)
  if (typeof header === 'string') return undefined
  if (header.frames !== claim.frames || header.durationSeconds !== claim.durationSeconds)
    return undefined
  return {
    segmentId: plan.request.segmentId,
    status: 'reused',
    voiceProfileId: plan.profile.id,
    usedFallback: plan.usedFallback,
    wavPath: plan.wavPath,
    manifestPath: plan.manifestPath,
    renderIdentitySha256: plan.identitySha256,
    audio: {
      sha256: claim.sha256,
      bytes: bytes.length,
      sampleRateHz: header.sampleRateHz,
      channels: header.channels,
      bitsPerSample: header.bitsPerSample,
      frames: header.frames,
      durationSeconds: header.durationSeconds,
    },
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, path)
    const directory = await open(dirname(path), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

export async function recordRendered(
  plan: SegmentPlan,
  config: LoadedProductionConfig,
  reportedSha256: string,
): Promise<SpeechSegmentResult> {
  const validated = await validateCanonicalWav(
    plan.wavPath,
    config.value.wav,
    plan.request.text,
    plan.request.segmentId,
  )
  if (validated.audio.sha256 !== reportedSha256) {
    throw new SpeechEngineError(
      'protocol',
      `Worker WAV hash mismatch for ${plan.request.segmentId}`,
      { segmentId: plan.request.segmentId },
    )
  }
  const manifest: RenderManifest = {
    schemaVersion: 1,
    segmentId: plan.request.segmentId,
    observedProductionConfigSha256: config.sha256,
    renderIdentitySha256: plan.identitySha256,
    renderIdentity: plan.identity,
    audio: { file: `${plan.request.segmentId}.wav`, ...validated.audio },
    createdAt: new Date().toISOString(),
  }
  await atomicWrite(plan.manifestPath, `${canonicalJson(manifest)}\n`)
  return {
    segmentId: plan.request.segmentId,
    status: 'rendered',
    voiceProfileId: plan.profile.id,
    usedFallback: plan.usedFallback,
    wavPath: plan.wavPath,
    manifestPath: plan.manifestPath,
    renderIdentitySha256: plan.identitySha256,
    audio: validated.audio,
  }
}
