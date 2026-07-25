import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { LoadedProductionConfig, VoiceProfile } from './config.js'
import type { SpeechSegmentRequest, SpeechSegmentResult } from './types.js'
import { validateCanonicalWav } from './wav.js'

export interface RenderIdentity {
  readonly adapter: LoadedProductionConfig['value']['adapter']
  readonly model: LoadedProductionConfig['value']['model']
  readonly runtime: LoadedProductionConfig['value']['runtime']
  readonly text: { readonly value: string; readonly sha256: string }
  readonly voice: VoiceProfile & { readonly usedFallback: boolean }
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
): SegmentPlan {
  const usedFallback = request.voiceProfileId === undefined
  const profileId = request.voiceProfileId ?? config.value.fallbackVoiceProfileId
  const profile = config.profiles.get(profileId)
  if (!profile) throw new Error(`Missing configured voice profile: ${profileId}`)
  const seed = deriveSeed(profile, request.segmentId)
  const identity: RenderIdentity = {
    adapter: config.value.adapter,
    model: config.value.model,
    runtime: config.value.runtime,
    text: { value: request.text, sha256: sha256(request.text) },
    voice: { ...profile, usedFallback },
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

export async function tryReuse(
  plan: SegmentPlan,
  config: LoadedProductionConfig,
): Promise<SpeechSegmentResult | undefined> {
  if (!(await isRegularFile(plan.manifestPath)) || !(await isRegularFile(plan.wavPath)))
    return undefined
  let manifest: RenderManifest
  try {
    manifest = JSON.parse(await readFile(plan.manifestPath, 'utf8')) as RenderManifest
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
  try {
    const validated = await validateCanonicalWav(
      plan.wavPath,
      config.value.wav,
      plan.request.text,
      plan.request.segmentId,
    )
    if (
      canonicalJson(validated.audio) !==
      canonicalJson({
        sha256: manifest.audio.sha256,
        bytes: manifest.audio.bytes,
        sampleRateHz: manifest.audio.sampleRateHz,
        channels: manifest.audio.channels,
        bitsPerSample: manifest.audio.bitsPerSample,
        frames: manifest.audio.frames,
        durationSeconds: manifest.audio.durationSeconds,
      })
    ) {
      return undefined
    }
    return {
      segmentId: plan.request.segmentId,
      status: 'reused',
      voiceProfileId: plan.profile.id,
      usedFallback: plan.usedFallback,
      wavPath: plan.wavPath,
      manifestPath: plan.manifestPath,
      renderIdentitySha256: plan.identitySha256,
      audio: validated.audio,
    }
  } catch {
    return undefined
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
  if (validated.audio.sha256 !== reportedSha256)
    throw new Error(`Worker WAV hash mismatch for ${plan.request.segmentId}`)
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
