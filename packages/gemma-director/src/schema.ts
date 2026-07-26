import { z } from 'zod'
import type { DIRECTOR_SEGMENT_KINDS, DirectionRequest } from './port.js'

const opaqueIdSchema = z.string().min(1).max(256)
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)

export const directionRequestSchema = z.strictObject({
  requestId: opaqueIdSchema,
  bookId: opaqueIdSchema,
  bookTitle: z.string().min(1),
  bookAuthor: z.string().min(1).nullable(),
  bookSourceSha256: sha256Schema,
  chapterId: opaqueIdSchema,
  chapterPosition: z.int().positive(),
  chapterTitle: z.string().min(1),
  passages: z
    .array(
      z.strictObject({
        id: opaqueIdSchema,
        text: z.string().min(1),
      }),
    )
    .min(1),
  speakers: z.array(
    z.strictObject({
      id: opaqueIdSchema,
      aliases: z.array(z.string().min(1).max(256)),
    }),
  ),
  narratorSpeakerId: opaqueIdSchema,
  fallbackSpeakerId: opaqueIdSchema,
  storyContext: z.string().max(100_000).optional(),
})

const deliverySchema = z.strictObject({
  emotion: z.enum(['neutral', 'calm', 'warm', 'uneasy', 'sad', 'firm', 'tense', 'weary']),
  pace: z.enum(['slow', 'normal', 'fast']),
  volume: z.enum(['soft', 'normal', 'loud']),
  pause_after_ms: z.int().min(0).max(10_000),
})

const directedWireBaseShape = {
  source_passage_id: opaqueIdSchema,
  source_text: z.string().min(1),
  confidence: z.number().min(0).max(1),
  delivery: deliverySchema,
} as const

const narratorOwnedWireSegmentSchema = z.strictObject({
  ...directedWireBaseShape,
  kind: z.enum(['narration', 'sound_cue']),
})

const unresolvedWireSegmentSchema = z.strictObject({
  ...directedWireBaseShape,
  kind: z.enum(['dialogue', 'thought', 'message']),
  speaker_id: z.null(),
  speaker_reason: z.string().min(1).max(240),
})

const resolvedWireSegmentSchemaFor = (speakerIds: readonly string[]) =>
  z.strictObject({
    ...directedWireBaseShape,
    kind: z.enum(['dialogue', 'thought', 'message']),
    speaker_id: z.enum(speakerIds as [string, ...string[]]),
    speaker_reason: z.null(),
  })

/**
 * Builds the exact provider schema for one request.
 *
 * Narrator/fallback roles are deliberately absent from the model's choices. Narrator ownership is
 * derived from kind; unresolved character-bearing content is represented by `speaker_id: null` and
 * a required reason. With an empty roster, the resolved branch does not exist in the JSON schema.
 */
export function directionWireOutputSchemaFor(request: DirectionRequest) {
  const speakerIds = request.speakers.map((speaker) => speaker.id)
  if (
    new Set(speakerIds).size !== speakerIds.length ||
    speakerIds.includes(request.narratorSpeakerId) ||
    speakerIds.includes(request.fallbackSpeakerId)
  ) {
    throw new Error('Direction output schema requires distinct character-only speaker IDs')
  }
  const segmentSchema =
    speakerIds.length === 0
      ? z.union([narratorOwnedWireSegmentSchema, unresolvedWireSegmentSchema])
      : z.union([
          narratorOwnedWireSegmentSchema,
          unresolvedWireSegmentSchema,
          resolvedWireSegmentSchemaFor(speakerIds),
        ])
  return z.strictObject({ segments: z.array(segmentSchema).min(1) })
}

export type NarratorOwnedWireSegment = z.infer<typeof narratorOwnedWireSegmentSchema>
export type UnresolvedWireSegment = z.infer<typeof unresolvedWireSegmentSchema>
export type ResolvedWireSegment = z.infer<ReturnType<typeof resolvedWireSegmentSchemaFor>>
export type ModelDirectedWireSegment =
  | NarratorOwnedWireSegment
  | UnresolvedWireSegment
  | ResolvedWireSegment
export interface DirectionWireOutput {
  readonly segments: readonly ModelDirectedWireSegment[]
}

/** Internal semantic form. Every role here was derived or admitted by the request-specific schema. */
export interface DirectedWireSegment {
  readonly source_passage_id: string
  readonly source_text: string
  readonly kind: (typeof DIRECTOR_SEGMENT_KINDS)[number]
  readonly speaker_id: string
  readonly confidence: number
  readonly delivery: z.infer<typeof deliverySchema>
  readonly unresolved_speaker: boolean
  readonly speaker_reason: string | null
}

export interface NormalizedDirectionWireOutput {
  readonly segments: readonly DirectedWireSegment[]
}

/**
 * Parses model output through the request-specific schema and derives the two special speaker roles.
 * This is a clean @4 boundary: old role-ID/boolean wire objects are intentionally rejected.
 */
export function parseDirectionOutputForValidation(
  input: unknown,
  request: DirectionRequest,
): NormalizedDirectionWireOutput {
  const parsed = directionWireOutputSchemaFor(request).parse(input) as DirectionWireOutput
  return {
    segments: parsed.segments.map((item): DirectedWireSegment => {
      if (!('speaker_id' in item)) {
        return {
          ...item,
          speaker_id: request.narratorSpeakerId,
          unresolved_speaker: false,
          speaker_reason: null,
        }
      }
      if (item.speaker_id === null) {
        return {
          ...item,
          speaker_id: request.fallbackSpeakerId,
          unresolved_speaker: true,
        }
      }
      return { ...item, unresolved_speaker: false }
    }),
  }
}

/** Representative policy schema used only for stable adapter-identity hashing. */
export const directionWireOutputIdentitySchema = directionWireOutputSchemaFor({
  requestId: 'identity-request',
  bookId: 'identity-book',
  bookTitle: 'Identity Book',
  bookAuthor: null,
  bookSourceSha256: '0'.repeat(64),
  chapterId: 'identity-chapter',
  chapterPosition: 1,
  chapterTitle: 'Identity Chapter',
  passages: [{ id: 'identity-passage', text: 'Identity text.' }],
  speakers: [{ id: 'request-character-speaker-id', aliases: [] }],
  narratorSpeakerId: 'adapter-derived-narrator-role',
  fallbackSpeakerId: 'adapter-derived-fallback-role',
})

/** Rejects duplicate input identities before any private text reaches the model endpoint. */
export function parseDirectionRequest(input: unknown): DirectionRequest {
  const request = directionRequestSchema.parse(input)
  const passageIds = new Set<string>()
  for (const passage of request.passages) {
    if (passageIds.has(passage.id)) throw new Error(`Duplicate source passage ID: ${passage.id}`)
    passageIds.add(passage.id)
  }
  const speakerIds = new Set<string>()
  for (const speaker of request.speakers) {
    if (speakerIds.has(speaker.id)) throw new Error(`Duplicate speaker ID: ${speaker.id}`)
    speakerIds.add(speaker.id)
  }
  if (request.narratorSpeakerId === request.fallbackSpeakerId) {
    throw new Error('Narrator and fallback speaker IDs must differ')
  }
  if (speakerIds.has(request.narratorSpeakerId) || speakerIds.has(request.fallbackSpeakerId)) {
    throw new Error('Narrator and fallback IDs must be separate from the character roster')
  }
  return {
    requestId: request.requestId,
    bookId: request.bookId,
    bookTitle: request.bookTitle,
    bookAuthor: request.bookAuthor,
    bookSourceSha256: request.bookSourceSha256,
    chapterId: request.chapterId,
    chapterPosition: request.chapterPosition,
    chapterTitle: request.chapterTitle,
    passages: request.passages,
    speakers: request.speakers,
    narratorSpeakerId: request.narratorSpeakerId,
    fallbackSpeakerId: request.fallbackSpeakerId,
    ...(request.storyContext === undefined ? {} : { storyContext: request.storyContext }),
  }
}
