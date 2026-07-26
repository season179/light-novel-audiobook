import { canonicalSliceDescriptor, type SliceLimits } from '@light-novel-audiobook/pipeline-driver'
import { WebApiError } from './errors.js'

/**
 * Web job identity. One rule, borrowed — never re-decided — from the driver:
 *
 * - A job is addressed by its EPUB's content hash, so re-opening or refreshing always finds the
 *   same run. The unbounded form is byte-identical to what it has always been:
 *   `job-<first 24 hex of the upload sha256>`.
 * - Stated slice bounds are bound into the job ID through `canonicalSliceDescriptor` — the same
 *   canonical string `SlicingEpubExtractor` binds into the extractor identity — so two different
 *   slices of one upload are two different jobs, and neither can be handed the other's audio.
 * - The descriptor is carried *in* the ID rather than hashed away because it is the only durable
 *   record of the bounds: a review resume (`renderApprovedScript`) and the runner's extractor
 *   wrapping both reconstruct the slice from the job ID alone. `sliceLimitsForJobId` is the decode;
 *   it is not a second identity rule — the canonical string it parses is produced only by
 *   `canonicalSliceDescriptor`.
 *
 * Identity decision (issue #84): absent bounds and bounds that merely spell the unbounded prefix
 * (`firstChapter: 1`, or nothing) produce exactly the historical ID. Any other stated bound — even
 * one that happens to span the whole book, like `maxChapters` ≥ the chapter count — is a *different*
 * job. The web API cannot know a book's length before extraction, so collapsing whole-book bounds
 * into the unbounded job would take a second rule that could disagree with the driver's; making
 * them distinct is the driver's own behaviour and fails safe (a re-render of identical content,
 * never the wrong audio).
 */

export interface ParsedJobId {
  /** The first 24 hex characters of the upload's sha256 — how the upload is located for a resume. */
  readonly uploadSha256Prefix: string
  /** The decoded bounds. `{}` when the ID names the whole book. */
  readonly limits: SliceLimits
}

const JOB_ID_PATTERN = /^job-(?<prefix>[0-9a-f]{24})(?:-slice-(?<descriptor>.+))?$/

const BOUND_NAMES = ['firstChapter', 'maxChapters', 'maxPassagesPerChapter'] as const

type BoundName = (typeof BOUND_NAMES)[number]

/** Decodes only canonical descriptors. Any spelling `deriveJobId` would not mint is rejected. */
const parseDescriptor = (descriptor: string): SliceLimits | null => {
  const limits: { -readonly [K in BoundName]?: number } = {}
  for (const pair of descriptor.split(',')) {
    const match = /^(?<name>[A-Za-z]+)=(?<value>\d+)$/.exec(pair)
    const name = match?.groups?.name as BoundName | undefined
    const raw = match?.groups?.value
    if (name === undefined || raw === undefined || !BOUND_NAMES.includes(name)) return null
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value < 1 || limits[name] !== undefined) return null
    limits[name] = value
  }

  // Parsing alone accepts aliases such as leading zeroes, reversed fields, or an explicitly stated
  // default. Re-encoding through the one identity rule makes those fail closed instead of letting
  // multiple externally supplied job IDs name one extractor identity.
  try {
    return canonicalSliceDescriptor(limits) === descriptor ? limits : null
  } catch (_error: unknown) {
    return null
  }
}

/** `null` when the ID is not a web job ID at all (for example a pipeline-driver job ID). */
export const parseJobId = (jobId: string): ParsedJobId | null => {
  const match = JOB_ID_PATTERN.exec(jobId)
  if (match === null) return null
  const prefix = match.groups?.prefix
  if (prefix === undefined) return null
  const descriptor = match.groups?.descriptor
  if (descriptor === undefined) return { uploadSha256Prefix: prefix, limits: {} }
  const limits = parseDescriptor(descriptor)
  if (limits === null) return null
  return { uploadSha256Prefix: prefix, limits }
}

/**
 * A job is addressed by its EPUB content plus its canonical slice bounds, so re-opening or
 * refreshing always finds the same run. Without bounds this is exactly the historical ID.
 */
export const deriveJobId = (uploadSha256: string, limits: SliceLimits = {}): string => {
  let descriptor: string | null
  try {
    descriptor = canonicalSliceDescriptor(limits)
  } catch (error) {
    throw new WebApiError(
      'invalid_request',
      error instanceof Error ? error.message : 'Slice bounds must be positive integers.',
    )
  }
  const base = `job-${uploadSha256.slice(0, 24)}`
  return descriptor === null ? base : `${base}-slice-${descriptor}`
}

/**
 * The bounds a run of this job must wrap its extractor with. Read from the job ID — the one
 * carrier every path (start, resume, retry) already agrees on — so a run whose extractor ignores
 * the bounds its job ID states is impossible to express.
 *
 * `{}` for the whole book, including for job IDs this server did not mint (a pipeline-driver job
 * has no slice suffix). A web-shaped ID with a malformed descriptor is rejected loudly: silently
 * rendering the whole book under a bounded-looking ID is the failure this type exists to prevent.
 */
export const sliceLimitsForJobId = (jobId: string): SliceLimits => {
  const parsed = parseJobId(jobId)
  if (parsed !== null) return parsed.limits
  if (/^job-[0-9a-f]{24}-slice-/.test(jobId)) {
    throw new WebApiError(
      'generation_rejected',
      'This job ID names a slice that cannot be understood. Start the generation again.',
    )
  }
  return {}
}
