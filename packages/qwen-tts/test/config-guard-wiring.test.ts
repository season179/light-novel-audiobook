/**
 * The two #92 cast guards are unit-tested next door, and that is not enough: deleting both calls from
 * `validateConfig` left every one of those tests green. Their subject is the *lock table* inside
 * `config.ts`, which no test can corrupt from the outside, so nothing else can observe whether the
 * call site still exists — and a guard nobody calls is decoration.
 *
 * This file watches the call site itself. The recorders wrap the real implementations rather than
 * replacing them, so the shipped config is still genuinely validated rather than waved through.
 */
import { describe, expect, it, vi } from 'vitest'

const recorded = vi.hoisted(() => ({
  distinct: [] as unknown[][],
  present: [] as unknown[][],
}))

vi.mock('../src/cast-distinctness.js', async (importOriginal) => {
  // The original must be reached from inside the factory. Importing it at module scope would resolve
  // to this mock and recurse until the stack dies — which it did, on the first run of this file.
  const original = await importOriginal<typeof import('../src/cast-distinctness.js')>()
  return {
    ...original,
    assertDistinctProfileMaterial: (...args: unknown[]) => {
      recorded.distinct.push(args)
      return (original.assertDistinctProfileMaterial as (...a: unknown[]) => void)(...args)
    },
    assertApprovedSpeakersPresent: (...args: unknown[]) => {
      recorded.present.push(args)
      return (original.assertApprovedSpeakersPresent as (...a: unknown[]) => void)(...args)
    },
  }
})

const PRODUCTION_CONFIG = new URL('../../../config/qwen3-tts-production.json', import.meta.url)

describe('validateConfig runs the cast guards on every load', () => {
  it('calls both guards over the full lock table', async () => {
    recorded.distinct.length = 0
    recorded.present.length = 0
    const { loadProductionConfig } = await import('../src/config.js')
    const { APPROVED_SPEAKERS } = await import('../src/types.js')

    await loadProductionConfig(PRODUCTION_CONFIG.pathname)

    expect(recorded.distinct).toHaveLength(1)
    expect(recorded.present).toHaveLength(1)

    // Not just "called" — called with every profile. A guard handed a subset would pass while a
    // duplicate hid in the entries it never saw.
    expect(recorded.distinct[0]?.[0]).toHaveLength(10)
    expect(recorded.present[0]?.[0]).toHaveLength(10)
    expect(recorded.present[0]?.[1]).toEqual(APPROVED_SPEAKERS)
  })
})
