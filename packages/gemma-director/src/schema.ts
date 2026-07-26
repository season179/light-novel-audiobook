import { z } from 'zod'
import { DIRECTOR_SEGMENT_KINDS, type DirectionRequest } from './port.js'

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

const directedWireContentShape = {
  source_passage_id: opaqueIdSchema,
  source_text: z.string().min(1),
  kind: z.enum(DIRECTOR_SEGMENT_KINDS),
  speaker_id: opaqueIdSchema,
  confidence: z.number().min(0).max(1),
  delivery: deliverySchema,
  unresolved_speaker: z.boolean(),
  speaker_reason: z.string().min(1).max(240).nullable(),
} as const

/**
 * The model classifies exact fragments; it does not calculate source coordinates. Range arithmetic is
 * derived deterministically after validation, because JSON schema can constrain an integer's shape but
 * cannot make an LLM count UTF-16 code units correctly.
 */
export const directedWireSegmentSchema = z.strictObject(directedWireContentShape)

export const directionWireOutputSchema = z.strictObject({
  segments: z.array(directedWireSegmentSchema).min(1),
})

/**
 * Read compatibility for captured `gemma-direction-output@2` responses. The two coordinates are
 * accepted only by `validateDirectionOutput`; they are stripped and never become source authority.
 * New provider requests use `directionWireOutputSchema`, whose JSON schema contains neither field.
 */
const legacyDirectedWireSegmentSchema = z.strictObject({
  ...directedWireContentShape,
  source_start: z.int().min(0),
  source_end: z.int().min(1),
})
const legacyDirectionWireOutputSchema = z.strictObject({
  segments: z.array(legacyDirectedWireSegmentSchema).min(1),
})

export type DirectionWireOutput = z.infer<typeof directionWireOutputSchema>
export type DirectedWireSegment = z.infer<typeof directedWireSegmentSchema>

export function parseDirectionOutputForValidation(input: unknown): DirectionWireOutput {
  const current = directionWireOutputSchema.safeParse(input)
  if (current.success) return current.data
  const legacy = legacyDirectionWireOutputSchema.safeParse(input)
  if (!legacy.success) throw current.error
  return {
    segments: legacy.data.segments.map(
      ({ source_start: _start, source_end: _end, ...item }) => item,
    ),
  }
}

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
