import { createHash } from 'node:crypto'
import { DomainError, type VoiceCast } from '@light-novel-audiobook/domain'
import { splitterIdentity as computeSplitterIdentity } from './split-directed-segments.js'

export interface GenerationCommandIdentityInput {
  readonly epubPath: string
  readonly epubSha256: string
  readonly voices: VoiceCast
  readonly epubExtractorIdentity: string
  readonly directorIdentity: string
  readonly speechEngineIdentity: string
  readonly audioAssemblerIdentity: string
  /**
   * Stable identity for the deterministic segment splitter (#55); changing it changes every segment
   * id, source text, render identity, and assembled audio. Defaults to the production splitter policy
   * so the binding is always present even when a caller does not name one explicitly.
   */
  readonly splitterIdentity?: string
}

/** Binds a job/result to every immutable input that can change direction, speech, or assembly. */
export const createGenerationCommandIdentity = (input: GenerationCommandIdentityInput): string => {
  if (input.epubPath.trim().length === 0) throw new DomainError('EPUB path is required')
  if (!/^[a-f\d]{64}$/i.test(input.epubSha256)) {
    throw new DomainError('EPUB identity must be a SHA-256 value')
  }
  const externalIdentities = [
    input.epubExtractorIdentity,
    input.directorIdentity,
    input.speechEngineIdentity,
    input.audioAssemblerIdentity,
  ]
  if (externalIdentities.some((identity) => identity.trim().length === 0)) {
    throw new DomainError('Extractor, director, speech, and assembler identities are required')
  }
  const splitterIdentity = input.splitterIdentity ?? computeSplitterIdentity()
  const canonical = JSON.stringify({
    schema: 2,
    epubPath: input.epubPath,
    epubSha256: input.epubSha256.toLowerCase(),
    cast: input.voices.generationIdentity,
    extractor: input.epubExtractorIdentity,
    director: input.directorIdentity,
    speech: input.speechEngineIdentity,
    assembly: input.audioAssemblerIdentity,
    splitter: splitterIdentity,
  })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}
