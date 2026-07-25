import type { Book, Chapter } from '@light-novel-audiobook/domain'
import type { DirectedChapter, DirectorModel } from './ports.js'

/**
 * Overrides a director's self-reported identity with a content-only one.
 *
 * A `DirectorModel` hashes its own identity, and a real adapter runs wherever it is told to:
 * `GemmaDirectorModel` folds its `baseUrl` and GPU lease lock file path into that hash. Those are
 * WHERE the model ran, not WHAT it produced — but `createGenerationCommandIdentity` binds the
 * reported identity to the job, so moving the brain port or the lock file between a crash and a
 * resume wedges the job with 'Audiobook job result is stale for the requested generation inputs'
 * while every rendered segment sits reusable on disk.
 *
 * The composition root applies this wrapper with an identity computed from the adapter's content
 * material only (model, prompt, output schema, generation settings — e.g. apps/web's
 * `createDirectorContentIdentity`), so environment moves stop invalidating resumable jobs while
 * genuine content changes still do.
 */
export const withDirectorContentIdentity = (
  director: DirectorModel,
  contentIdentity: string,
): DirectorModel => {
  if (contentIdentity.trim().length === 0) {
    throw new Error('Director content identity is required')
  }
  return {
    identity: contentIdentity,
    directChapter: (book: Book, chapter: Chapter): Promise<DirectedChapter> =>
      director.directChapter(book, chapter),
    release: (): Promise<void> => director.release(),
  }
}
