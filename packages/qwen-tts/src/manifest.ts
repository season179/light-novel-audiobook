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
import { validateCanonicalWav } from './wav.js'

const SHA256 = /^[0-9a-f]{64}$/

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

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    return info.isFile() && !info.isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Reads a cached artifact. A vanished file simply invalidates reuse; any other error (EIO, EACCES)
 * is surfaced so a failing disk never masquerades as a stale segment and triggers a needless GPU
 * re-render of the whole book.
 */
async function readCached(
  path: string,
  label: string,
  segmentId: string,
): Promise<Buffer | undefined> {
  try {
    return await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new SpeechEngineError(
      'audio-validation',
      `Cannot read cached ${label} for ${segmentId}: ${path}`,
      { cause: error, segmentId },
    )
  }
}

/**
 * Structural O(1) check of the recorded audio identity. The deep per-sample health gate already
 * ran on this exact byte sequence when it was rendered (both here and in the Python worker), so
 * reuse only has to prove the bytes on disk are still that sequence.
 */
function recordedAudioIdentity(
  manifest: RenderManifest,
  requirements: WavRequirements,
): SpeechAudioIdentity | undefined {
  const audio = manifest.audio as Partial<SpeechAudioIdentity> | undefined
  if (audio === undefined) return undefined
  const digest = audio.sha256
  const frames = audio.frames
  const bytes = audio.bytes
  const sampleRateHz = requirements.sampleRateHz
  const bytesPerFrame = requirements.channels * (requirements.bitsPerSample / 8)
  if (
    typeof digest !== 'string' ||
    !SHA256.test(digest) ||
    typeof frames !== 'number' ||
    typeof bytes !== 'number' ||
    !Number.isSafeInteger(frames) ||
    frames <= 0 ||
    audio.sampleRateHz !== sampleRateHz ||
    audio.channels !== requirements.channels ||
    audio.bitsPerSample !== requirements.bitsPerSample ||
    bytes !== 44 + frames * bytesPerFrame ||
    audio.durationSeconds !== frames / sampleRateHz
  ) {
    return undefined
  }
  return {
    sha256: digest,
    bytes,
    sampleRateHz,
    channels: requirements.channels,
    bitsPerSample: requirements.bitsPerSample,
    frames,
    durationSeconds: frames / sampleRateHz,
  }
}

export async function tryReuse(
  plan: SegmentPlan,
  config: LoadedProductionConfig,
): Promise<SpeechSegmentResult | undefined> {
  if (!(await isRegularFile(plan.manifestPath)) || !(await isRegularFile(plan.wavPath)))
    return undefined
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
    manifest.renderIdentitySha256 !== plan.identitySha256 ||
    canonicalJson(manifest.renderIdentity) !== canonicalJson(plan.identity) ||
    manifest.audio?.file !== `${plan.request.segmentId}.wav`
  ) {
    return undefined
  }
  const audio = recordedAudioIdentity(manifest, config.value.wav)
  if (audio === undefined) return undefined
  const bytes = await readCached(plan.wavPath, 'WAV', plan.request.segmentId)
  if (bytes === undefined) return undefined
  if (bytes.length !== audio.bytes || sha256(bytes) !== audio.sha256) return undefined
  return {
    segmentId: plan.request.segmentId,
    status: 'reused',
    voiceProfileId: plan.profile.id,
    usedFallback: plan.usedFallback,
    wavPath: plan.wavPath,
    manifestPath: plan.manifestPath,
    renderIdentitySha256: plan.identitySha256,
    audio,
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
