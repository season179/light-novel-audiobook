import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const DIAGNOSTIC_SCHEMA_VERSION = 1 as const
const MAX_DEPTH = 16
const MAX_ARRAY_ITEMS = 2_000
const MAX_OBJECT_PROPERTIES = 500

interface RedactedString {
  readonly redacted: true
  readonly sha256: string
  /** JavaScript/UTF-16 length, matching director source offsets. */
  readonly length: number
}

type DiagnosticValue =
  | null
  | boolean
  | number
  | string
  | RedactedString
  | readonly DiagnosticValue[]
  | { readonly [key: string]: DiagnosticValue }

const FIDELITY_FINDING_CODES = new Set([
  'text_omission',
  'text_insertion',
  'text_duplication',
  'text_substitution',
  'passage_reorder',
  'unknown_passage',
  'split_grapheme',
  'unknown_speaker',
  'speaker_semantics',
])

const hashString = (value: string): RedactedString => ({
  redacted: true,
  sha256: createHash('sha256').update(value, 'utf8').digest('hex'),
  length: value.length,
})

const normalizedKey = (key: string): string => key.replace(/[^a-z\d]/gi, '').toLowerCase()

/**
 * Only identifiers, hashes, codes and fixed diagnostic vocabulary cross verbatim. Free-form strings
 * are fingerprints, not excerpts. In particular source_text, prompt/request bodies, model echoes,
 * titles, character names and aliases all fall through to SHA-256 + UTF-16 length.
 */
const stringIsSafeForKey = (key: string): boolean => {
  const normalized = normalizedKey(key)
  return (
    normalized === 'name' ||
    normalized.endsWith('code') ||
    normalized.endsWith('codes') ||
    normalized.endsWith('category') ||
    normalized.endsWith('categories') ||
    normalized === 'type' ||
    normalized === 'syscall' ||
    normalized === 'providercode' ||
    normalized.endsWith('id') ||
    normalized.endsWith('ids') ||
    normalized.includes('sha256') ||
    normalized.endsWith('hash') ||
    normalized.endsWith('codepoint')
  )
}

const serializeFailure = (root: unknown): DiagnosticValue => {
  const seen = new WeakSet<object>()

  const visit = (value: unknown, key: string, depth: number): DiagnosticValue => {
    if (value === null || value === undefined) return null
    if (typeof value === 'boolean' || typeof value === 'number') {
      return typeof value === 'number' && !Number.isFinite(value) ? String(value) : value
    }
    if (typeof value === 'string') {
      return stringIsSafeForKey(key) ? value : hashString(value)
    }
    if (typeof value === 'bigint') return value.toString()
    if (typeof value !== 'object') return hashString(String(value))
    if (depth >= MAX_DEPTH) return { truncated: true }
    if (seen.has(value)) return { circular: true }
    seen.add(value)

    if (Array.isArray(value)) {
      const serialized = value.slice(0, MAX_ARRAY_ITEMS).map((item) => visit(item, key, depth + 1))
      if (value.length > MAX_ARRAY_ITEMS) serialized.push({ truncatedItems: value.length })
      return serialized
    }

    if (value instanceof Date) return value.toISOString()

    const record = value as Record<string, unknown>
    const isError = value instanceof Error
    const isFidelityFinding =
      typeof record.code === 'string' &&
      FIDELITY_FINDING_CODES.has(record.code) &&
      typeof record.sourcePassageId === 'string'
    const output: Record<string, DiagnosticValue> = {}

    if (isError) {
      output.kind = 'error'
      output.name = value.name
      // Error messages are diagnostic vocabulary. Director failures normalize provider errors and
      // fidelity findings use fixed prose; stacks are deliberately omitted below.
      output.message = value.message
    } else if (Object.getPrototypeOf(value) !== Object.prototype) {
      output.kind = 'object'
      output.name = value.constructor?.name ?? 'Object'
    }

    const propertyNames = Object.getOwnPropertyNames(value)
      .filter(
        (property) =>
          property !== 'stack' && property !== 'name' && (property !== 'message' || !isError),
      )
      .slice(0, MAX_OBJECT_PROPERTIES)
    for (const property of propertyNames) {
      let propertyValue: unknown
      try {
        propertyValue = record[property]
      } catch {
        output[property] = { inaccessible: true }
        continue
      }
      if (property === 'message' && isFidelityFinding && typeof propertyValue === 'string') {
        output[property] = propertyValue
      } else {
        output[property] = visit(propertyValue, property, depth + 1)
      }
    }
    if (Object.getOwnPropertyNames(value).length > MAX_OBJECT_PROPERTIES) {
      output.truncatedProperties = Object.getOwnPropertyNames(value).length
    }
    return output
  }

  return visit(root, 'error', 0)
}

export interface FailureDiagnosticArtifact {
  readonly schemaVersion: typeof DIAGNOSTIC_SCHEMA_VERSION
  readonly jobId: string
  readonly occurredAt: string
  readonly error: DiagnosticValue
}

export const failureDiagnosticDirectory = (workspaceRoot: string): string =>
  join(workspaceRoot, 'diagnostics', 'jobs')

/**
 * Writes one immutable, job-addressed diagnostic artifact. Persistence is best effort by design:
 * failure to create or extend diagnostics must never replace the pipeline error or stop a job from
 * reaching its failed state. Callers advertise the returned path only when this completed.
 */
export async function persistFailureDiagnostic(
  workspaceRoot: string,
  jobId: string,
  error: unknown,
): Promise<string | undefined> {
  const occurredAt = new Date().toISOString()
  const artifact: FailureDiagnosticArtifact = {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    jobId,
    occurredAt,
    error: serializeFailure(error),
  }
  const bytes = `${JSON.stringify(artifact, null, 2)}\n`
  const artifactHash = createHash('sha256').update(bytes, 'utf8').digest('hex')
  const jobDirectory = join(
    failureDiagnosticDirectory(workspaceRoot),
    createHash('sha256').update(jobId, 'utf8').digest('hex'),
  )
  const target = join(jobDirectory, `failure-${artifactHash}.json`)
  const temporary = join(jobDirectory, `.failure-${randomUUID()}.tmp`)

  try {
    await mkdir(jobDirectory, { recursive: true, mode: 0o700 })
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
    await rename(temporary, target)
    return target
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined)
    return undefined
  }
}

/** For containment tests and operator tooling without duplicating path knowledge. */
export const failureDiagnosticRootOf = (artifactPath: string): string =>
  dirname(dirname(artifactPath))
