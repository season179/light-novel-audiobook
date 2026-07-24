import { describe, expect, it } from 'vitest'
import { RenderPassage, SourcePassage } from '../src/index.js'

describe('source fidelity', () => {
  it('keeps source text unchanged when render text is derived', () => {
    const exactSource = 'Room 101… Don’t go.'
    const source = new SourcePassage({
      id: 'ch01-p0001',
      chapterId: 'ch01',
      sourceText: exactSource,
    })

    const rendered = new RenderPassage(source, 'Room one oh one... Don’t go.', [
      {
        kind: 'number',
        sourceStart: 5,
        sourceEnd: 8,
        replacement: 'one oh one',
      },
    ])

    expect(rendered.source.sourceText).toBe(exactSource)
    expect(rendered.renderText).not.toBe(exactSource)
  })
})
