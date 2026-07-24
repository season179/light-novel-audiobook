import { z } from 'zod'

export const segmentKindSchema = z.enum([
  'narration',
  'dialogue',
  'thought',
  'message',
  'sound_cue',
])

export const segmentSchema = z.strictObject({
  chapter: z.int().min(1),
  segment_id: z.string().regex(/^ch[0-9]+-[0-9]+$/),
  kind: segmentKindSchema,
  speaker: z.string().min(1),
  voice: z.string().min(1),
  text: z.string().min(1),
  render_text: z.string().min(1).optional(),
  emotion: z.string().default('neutral'),
  confidence: z.number().min(0).max(1),
  pause_after_ms: z.int().min(0).max(10_000),
  review_required: z.boolean().default(false),
  source_start: z.int().min(0).optional(),
  source_end: z.int().min(0).optional(),
})

export type Segment = z.infer<typeof segmentSchema>
export type SegmentKind = z.infer<typeof segmentKindSchema>
