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

export const directedWireSegmentSchema = z.strictObject({
  source_passage_id: opaqueIdSchema,
  source_start: z.int().min(0),
  source_end: z.int().min(1),
  source_text: z.string().min(1),
  kind: z.enum(DIRECTOR_SEGMENT_KINDS),
  speaker_id: opaqueIdSchema,
  confidence: z.number().min(0).max(1),
  delivery: deliverySchema,
  unresolved_speaker: z.boolean(),
  speaker_reason: z.string().min(1).max(240).nullable(),
})

export const directionWireOutputSchema = z.strictObject({
  segments: z.array(directedWireSegmentSchema).min(1),
})

export type DirectionWireOutput = z.infer<typeof directionWireOutputSchema>
export type DirectedWireSegment = z.infer<typeof directedWireSegmentSchema>

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
