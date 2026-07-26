import { createHash } from 'node:crypto'
import { DomainError, type VoiceCast } from '@light-novel-audiobook/domain'

export interface GenerationCommandIdentityInput {
  readonly epubSha256: string
  readonly voices: VoiceCast
  readonly epubExtractorIdentity: string
  readonly directorIdentity: string
  readonly speechEngineIdentity: string
  readonly audioAssemblerIdentity: string
  /**
   * Stable identity for the deterministic segment splitter (#55); changing it changes every segment
   * id, source text, render identity, and assembled audio. Required (not defaulted) so a caller that
   * builds a non-default splitter policy cannot forget to bind it -- two renders sharing one identity
   * is the resume corruption this field exists to prevent.
   */
  readonly splitterIdentity: string
}

/**
 * Binds a job/result to every immutable input that can change direction, speech, or assembly.
 *
 * Identity covers WHAT WAS PRODUCED, not WHERE IT RAN FROM (issue #54). The EPUB's content hash
 * is in; its upload path is not — the extractor re-hashes the bytes and the use case verifies
 * `book.source.sha256 === command.epubSha256`, so a path contributes nothing to identity while a
 * fresh temp path per upload attempt would wedge every retry with a stale-result error. Schema 2
 * included `epubPath`; schema 3 removes it, which moves every command identity once — acceptable
 * because schema v1 workspaces are unreleased and disposable, and the stale-result error says why.
 */
export const createGenerationCommandIdentity = (input: GenerationCommandIdentityInput): string => {
  if (!/^[a-f\d]{64}$/i.test(input.epubSha256)) {
    throw new DomainError('EPUB identity must be a SHA-256 value')
  }
  const externalIdentities = [
    input.epubExtractorIdentity,
    input.directorIdentity,
    input.speechEngineIdentity,
    input.audioAssemblerIdentity,
    input.splitterIdentity,
  ]
  if (externalIdentities.some((identity) => identity.trim().length === 0)) {
    throw new DomainError(
      'Extractor, director, speech, assembler, and splitter identities are required',
    )
  }
  const canonical = JSON.stringify({
    schema: 3,
    epubSha256: input.epubSha256.toLowerCase(),
    cast: input.voices.generationIdentity,
    extractor: input.epubExtractorIdentity,
    director: input.directorIdentity,
    speech: input.speechEngineIdentity,
    assembly: input.audioAssemblerIdentity,
    splitter: input.splitterIdentity,
  })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}
