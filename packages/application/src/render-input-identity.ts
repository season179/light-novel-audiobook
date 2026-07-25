import { createHash } from 'node:crypto'
import type { Segment, VoiceProfile } from '@light-novel-audiobook/domain'

/** Content address for reusable WAVs. Every speech-affecting input is represented. */
export const createRenderInputIdentity = (
  segment: Segment,
  voice: VoiceProfile,
  speechEngineIdentity: string,
): string => {
  if (speechEngineIdentity.length === 0) throw new Error('Speech engine identity is required')
  const canonicalInput = JSON.stringify({
    schema: 1,
    engine: speechEngineIdentity,
    segment: {
      id: segment.id,
      sourceText: segment.sourceText,
      kind: segment.kind,
      speakerId: segment.speakerId,
      delivery: segment.delivery,
    },
    voice: voice.renderIdentity,
  })
  return createHash('sha256').update(canonicalInput, 'utf8').digest('hex')
}
