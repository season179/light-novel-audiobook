import { describe, expect, it } from 'vitest'
import { segmentSchema } from '../src/index.js'

describe('segment schema', () => {
  it('accepts separate source and render text', () => {
    const segment = segmentSchema.parse({
      chapter: 1,
      segment_id: 'ch01-0001',
      kind: 'narration',
      speaker: 'narrator',
      voice: 'narrator',
      text: 'Room 101.',
      render_text: 'Room one oh one.',
      confidence: 1,
      pause_after_ms: 300,
    })

    expect(segment.text).toBe('Room 101.')
    expect(segment.render_text).toBe('Room one oh one.')
  })

  it('rejects fields outside the contract', () => {
    const result = segmentSchema.safeParse({
      chapter: 1,
      segment_id: 'ch01-0001',
      kind: 'narration',
      speaker: 'narrator',
      voice: 'narrator',
      text: 'Exact source text.',
      confidence: 1,
      pause_after_ms: 300,
      invented_field: 'not allowed',
    })

    expect(result.success).toBe(false)
  })
})
