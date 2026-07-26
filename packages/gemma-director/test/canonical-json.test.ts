import { describe, expect, it } from 'vitest'
import { canonicalJson, canonicalSha256 } from '../src/canonical-json.js'

// Issue #63. A canonical-form serializer must be deterministic across environments: localeCompare
// is locale- and ICU-dependent, so the same object could hash to different values on two machines
// — and canonicalSha256 feeds the director identity, which the generation command binds to a job.
//
// The key pair below is chosen because the two comparators DISAGREE on it, verified on this Node:
//   '-' is U+002D and '_' is U+005F, so code-point order puts 'typing-inspection' first, while
//   'typing-inspection'.localeCompare('typing_extensions') === 1 puts 'typing_extensions' first.
// Alphabetic-only keys pass under either comparator and would prove nothing.

describe('canonicalJson', () => {
  it('sorts object keys by code point, not by locale', () => {
    expect(canonicalJson({ typing_extensions: 1, 'typing-inspection': 2 })).toBe(
      '{"typing-inspection":2,"typing_extensions":1}',
    )
  })

  it('hashes the same content identically regardless of key insertion order', () => {
    const hyphenFirst = canonicalSha256({ 'typing-inspection': 2, typing_extensions: 1 })
    const underscoreFirst = canonicalSha256({ typing_extensions: 1, 'typing-inspection': 2 })
    expect(hyphenFirst).toBe(underscoreFirst)
    expect(hyphenFirst).toMatch(/^[a-f\d]{64}$/)
  })

  it('sorts nested object keys by code point as well', () => {
    expect(canonicalJson({ outer: { typing_extensions: 1, 'typing-inspection': 2 } })).toBe(
      '{"outer":{"typing-inspection":2,"typing_extensions":1}}',
    )
  })
})
