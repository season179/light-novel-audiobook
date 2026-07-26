import { createHash } from 'node:crypto'
import { DomainError, type VoiceCast } from '@light-novel-audiobook/domain'

export interface RenderContractInput {
  readonly voices: VoiceCast
  readonly speechEngineIdentity: string
  readonly audioAssemblerIdentity: string
}

/**
 * Digest of everything the render stage supplies that the job's `commandIdentity` also covers.
 *
 * `RenderAudiobook` is a public continuation path — the review UI calls it directly after a decision
 * — but it holds no extractor and no director, so it cannot recompute `commandIdentity` to check
 * that it was handed the same inputs direction used. Per-segment identities catch a changed cast or
 * speech engine by refusing to reuse audio, but they do not stop the job completing, and the
 * assembler is not represented in them at all. Without this the stored `commandIdentity` could stop
 * describing what actually produced the completed output.
 */
export const createRenderContract = (input: RenderContractInput): string => {
  if (
    input.speechEngineIdentity.trim().length === 0 ||
    input.audioAssemblerIdentity.trim().length === 0
  ) {
    throw new DomainError('Speech and assembler identities are required for a render contract')
  }
  return createHash('sha256')
    .update(
      JSON.stringify({
        schema: 'render-contract@1',
        cast: input.voices.generationIdentity,
        speech: input.speechEngineIdentity,
        assembly: input.audioAssemblerIdentity,
      }),
      'utf8',
    )
    .digest('hex')
}
