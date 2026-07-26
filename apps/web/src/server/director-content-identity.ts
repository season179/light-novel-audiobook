import {
  createGemmaDirectorContentIdentity,
  type GemmaDirectorIdentitySettings,
} from '@light-novel-audiobook/gemma-director'

/**
 * The director identity as seen by the generation command: WHAT the director is, never WHERE it
 * ran. `GemmaDirectorModel` hashes its own identity from the settings it is constructed with, and
 * those settings carry the environment — `baseUrl` (the brain's address; ports are configurable
 * per docs/PLAN.md) and `gpuLeaseLockFilePath` (a local file). Moving either between a crash and a
 * resume moved the command identity and wedged the job with 'Audiobook job result is stale for the
 * requested generation inputs' while every rendered segment sat reusable on disk (issue #54).
 *
 * Pinning the two environment fields to constants keeps the adapter's own canonical hashing —
 * model, prompt, output schema, runtime generation settings and the confidence threshold all still
 * bind — while a port move or lock-file move provably cannot move the identity.
 *
 * Wire the real director through this at the composition seam:
 * `withDirectorContentIdentity(new GemmaDirectorModel(options), createDirectorContentIdentity(options))`.
 */
export const createDirectorContentIdentity = (settings: GemmaDirectorIdentitySettings): string =>
  createGemmaDirectorContentIdentity(settings)
