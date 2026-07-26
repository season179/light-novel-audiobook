import { describe, expect, it } from 'vitest'
import type { DirectionRequest } from '../src/port.js'
import { directionWireOutputSchemaFor, parseDirectionOutputForValidation } from '../src/schema.js'
import { validateDirectionOutput } from '../src/validation.js'

const request = (speakerIds: readonly string[]): DirectionRequest => ({
  requestId: 'speaker-schema-request',
  bookId: 'book-speaker-schema',
  bookTitle: 'Invented Test Book',
  bookAuthor: null,
  bookSourceSha256: 'a'.repeat(64),
  chapterId: 'chapter-speaker-schema',
  chapterPosition: 1,
  chapterTitle: 'Invented Chapter',
  passages: [{ id: 'passage-1', text: '“Is anyone there?”' }],
  speakers: speakerIds.map((id) => ({ id, aliases: [] })),
  narratorSpeakerId: 'narrator-role',
  fallbackSpeakerId: 'fallback-role',
})

const delivery = {
  emotion: 'neutral' as const,
  pace: 'normal' as const,
  volume: 'normal' as const,
  pause_after_ms: 200,
}

const common = {
  source_passage_id: 'passage-1',
  source_text: '“Is anyone there?”',
  confidence: 0.8,
  delivery,
}

describe('request-specific speaker role schema', () => {
  it('with an empty roster cannot represent narrator or fallback IDs as dialogue speakers', () => {
    const schema = directionWireOutputSchemaFor(request([]))
    for (const roleId of ['narrator-role', 'fallback-role']) {
      expect(
        schema.safeParse({
          segments: [
            {
              ...common,
              kind: 'dialogue',
              speaker_id: roleId,
              speaker_reason: null,
            },
          ],
        }).success,
      ).toBe(false)
    }
  })

  it('maps null plus a reason to fallback and derives unresolved status', () => {
    const input = {
      segments: [
        {
          ...common,
          kind: 'dialogue',
          speaker_id: null,
          speaker_reason: 'No eligible character is present in the supplied roster.',
        },
      ],
    }
    expect(directionWireOutputSchemaFor(request([])).safeParse(input).success).toBe(true)

    const normalized = parseDirectionOutputForValidation(input, request([]))
    expect(normalized.segments[0]).toMatchObject({
      speaker_id: 'fallback-role',
      unresolved_speaker: true,
    })
    const validated = validateDirectionOutput(input, request([]), 0.5)
    expect(validated.annotations[0]?.speakerId).toBe('fallback-role')
    expect('unresolvedSpeaker' in (validated.annotations[0] ?? {})).toBe(false)
    expect(validated.warnings).toMatchObject([
      {
        code: 'unresolved_speaker',
        usesFallback: true,
        candidateSpeakerId: null,
        message: 'No eligible character is present in the supplied roster.',
      },
    ])
  })

  it('rejects a resolved roster ID carrying a non-null reason', () => {
    const schema = directionWireOutputSchemaFor(request(['mira']))
    expect(
      schema.safeParse({
        segments: [
          {
            ...common,
            kind: 'dialogue',
            speaker_id: 'mira',
            speaker_reason: 'This must not accompany a resolved speaker.',
          },
        ],
      }).success,
    ).toBe(false)
    expect(
      schema.safeParse({
        segments: [{ ...common, kind: 'dialogue', speaker_id: 'mira', speaker_reason: null }],
      }).success,
    ).toBe(true)
  })

  it('derives narration ownership instead of accepting a model-chosen speaker', () => {
    const schema = directionWireOutputSchemaFor(request(['mira']))
    const narration = { segments: [{ ...common, kind: 'narration' }] }
    expect(schema.safeParse(narration).success).toBe(true)
    expect(
      schema.safeParse({
        segments: [
          {
            ...common,
            kind: 'narration',
            speaker_id: 'narrator-role',
            speaker_reason: null,
          },
        ],
      }).success,
    ).toBe(false)
    expect(
      parseDirectionOutputForValidation(narration, request(['mira'])).segments[0],
    ).toMatchObject({
      speaker_id: 'narrator-role',
      unresolved_speaker: false,
    })
  })

  it('rejects the old role IDs and unresolved boolean without a compatibility shim', () => {
    const schema = directionWireOutputSchemaFor(request(['mira']))
    expect(
      schema.safeParse({
        segments: [
          {
            ...common,
            kind: 'narration',
            speaker_id: 'narrator-role',
            unresolved_speaker: false,
            speaker_reason: null,
          },
        ],
      }).success,
    ).toBe(false)
  })

  it('requires a non-empty reason for unresolved character-bearing content', () => {
    const schema = directionWireOutputSchemaFor(request(['mira']))
    for (const speakerReason of [null, '']) {
      expect(
        schema.safeParse({
          segments: [
            {
              ...common,
              kind: 'dialogue',
              speaker_id: null,
              speaker_reason: speakerReason,
            },
          ],
        }).success,
      ).toBe(false)
    }
  })
})
