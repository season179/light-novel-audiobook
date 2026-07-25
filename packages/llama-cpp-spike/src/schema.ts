import { z } from 'zod'

export const SyntheticStructuredOutputSchema = z
  .object({
    verdict: z.literal('pass'),
    summary: z.string().min(1).max(64),
  })
  .strict()

export type SyntheticStructuredOutput = z.infer<typeof SyntheticStructuredOutputSchema>

export const HealthResponseSchema = z
  .object({
    status: z.string().min(1),
  })
  .passthrough()

export const ModelsResponseSchema = z.object({
  data: z.array(
    z
      .object({
        id: z.string().min(1),
      })
      .passthrough(),
  ),
})

export const PropsResponseSchema = z
  .object({
    total_slots: z.number().int().positive().optional(),
    default_generation_settings: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()
