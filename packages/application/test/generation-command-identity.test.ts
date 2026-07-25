import { VoiceCast, VoiceProfile, type VoiceProfileProps } from '@light-novel-audiobook/domain'
import { describe, expect, it } from 'vitest'
import { createGenerationCommandIdentity } from '../src/generation-command-identity.js'
import { SEPARATOR_OVERSHOOT, splitterIdentity } from '../src/split-directed-segments.js'

const profile = (
  id: string,
  role: 'narrator' | 'fallback' | 'character',
  speakerId: string | null,
): VoiceProfile => {
  const props: VoiceProfileProps = {
    id,
    displayName: id,
    role,
    speakerId,
    syntheticSpeaker: role === 'narrator' ? 'Aiden' : 'Ryan',
    instruction: `${id} instruction`,
    seed: 1,
    revision: 1,
  }
  return new VoiceProfile(props)
}

const cast = new VoiceCast(
  profile('narrator-voice', 'narrator', null),
  profile('fallback-voice', 'fallback', null),
  [profile('alice-voice', 'character', 'alice')],
)

const baseInput = {
  epubPath: '/absolute/path/to/book.epub',
  epubSha256: 'a'.repeat(64),
  voices: cast,
  epubExtractorIdentity: 'extractor-identity',
  directorIdentity: 'director-identity',
  speechEngineIdentity: 'speech-identity',
  audioAssemblerIdentity: 'assembler-identity',
  splitterIdentity: splitterIdentity(),
}

describe('splitter identity is bound into the generation command identity (#55 r2, MEDIUM 2)', () => {
  it('splitterIdentity changes when the budget or overshoot changes', () => {
    const at400 = splitterIdentity({
      maxFragmentCharacters: 400,
      separatorOvershoot: SEPARATOR_OVERSHOOT,
    })
    const at380 = splitterIdentity({
      maxFragmentCharacters: 380,
      separatorOvershoot: SEPARATOR_OVERSHOOT,
    })
    const tighterOvershoot = splitterIdentity({
      maxFragmentCharacters: 400,
      separatorOvershoot: SEPARATOR_OVERSHOOT - 1,
    })
    expect(at400).not.toBe(at380)
    expect(at400).not.toBe(tighterOvershoot)
  })

  it('changing the splitter budget invalidates the generation command identity', () => {
    const at400 = createGenerationCommandIdentity(baseInput)
    const at380 = createGenerationCommandIdentity({
      ...baseInput,
      splitterIdentity: splitterIdentity({
        maxFragmentCharacters: 380,
        separatorOvershoot: SEPARATOR_OVERSHOOT,
      }),
    })
    expect(at380).not.toBe(at400)
  })
})
