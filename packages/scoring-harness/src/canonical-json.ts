import { createHash } from 'node:crypto'

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject
export type JsonObject = { readonly [key: string]: JsonValue }

/** RFC-8785-like canonical JSON for this harness's integer/string/boolean input domain. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical JSON cannot contain non-finite numbers')
    return JSON.stringify(value)
  }
  if (Array.isArray(value))
    return `[${(value as readonly JsonValue[]).map(canonicalJson).join(',')}]`

  const object = value as JsonObject
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key] as JsonValue)}`)
    .join(',')}}`
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function canonicalSha256(value: JsonValue): string {
  return sha256(canonicalJson(value))
}
