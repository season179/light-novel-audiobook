import { createHash } from 'node:crypto'
import { DomainError, type Segment, type VoiceProfile } from '@light-novel-audiobook/domain'

/** The part of a persisted approval that changes what a fallback segment is authorized to be. */
export interface RenderInputApproval {
  readonly approvalId: string
  readonly approvalSha256: string
}

/**
 * Content address for reusable WAVs. Every speech-affecting input is represented — **including the
 * human decision that authorized a fallback voice**.
 *
 * Binding the approval here is not redundant with the Qwen adapter's own manifest binding. The
 * adapter can only notice a changed decision if it is asked to render at all, and
 * `RenderAudiobook.planRendering()` reuses an existing WAV without calling the engine. Before this,
 * revoking an approval left the old audio reusable forever and the engine never saw the segment.
 *
 * `schema: 2` is the version that added it. The field is present unconditionally, including as
 * `null` for the great majority of segments that use a cast voice, so there is no branch in which
 * an approval can be silently absent from the hash; the cost is that every pre-#45 content address
 * moves once.
 */
export const createRenderInputIdentity = (
  segment: Segment,
  voice: VoiceProfile,
  speechEngineIdentity: string,
  fallbackApproval: RenderInputApproval | null = null,
): string => {
  if (speechEngineIdentity.length === 0) throw new Error('Speech engine identity is required')
  // A cast voice carrying a fallback approval is a wiring fault, not a reuse question: it would
  // give a segment nobody reviewed an identity that looks reviewed.
  if (fallbackApproval !== null && segment.voiceAssignment?.usesFallback !== true) {
    throw new DomainError(
      `Segment ${segment.id} does not use the fallback voice and cannot carry an approval`,
    )
  }
  const canonicalInput = JSON.stringify({
    schema: 2,
    engine: speechEngineIdentity,
    segment: {
      id: segment.id,
      sourceText: segment.sourceText,
      kind: segment.kind,
      speakerId: segment.speakerId,
      delivery: segment.delivery,
    },
    voice: voice.renderIdentity,
    fallbackApproval:
      fallbackApproval === null
        ? null
        : {
            approvalId: fallbackApproval.approvalId,
            approvalSha256: fallbackApproval.approvalSha256,
          },
  })
  return createHash('sha256').update(canonicalInput, 'utf8').digest('hex')
}
