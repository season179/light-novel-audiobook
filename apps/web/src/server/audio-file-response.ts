import type { OpenAudioFile } from './audiobook-web-api.js'
import { toPublicFailure } from './errors.js'

const NOT_FOUND_CODES = new Set([
  'unknown_job',
  'unknown_upload',
  'output_unavailable',
  'invalid_request',
])

const contentDisposition = (fileName: string, attachment: boolean): string => {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const disposition = attachment ? 'attachment' : 'inline'
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}

/**
 * Streams an already-validated workspace file from its open handle. Nothing is buffered, and the
 * handle came from the containment check itself, so the file cannot be swapped between check and read.
 */
export const audioFileResponse = (file: OpenAudioFile): Response => {
  const { descriptor } = file
  return new Response(file.body(), {
    status: 200,
    headers: {
      'Content-Type': descriptor.contentType,
      'Content-Length': String(descriptor.byteLength),
      'Content-Disposition': contentDisposition(descriptor.fileName, descriptor.attachment),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

/** Sanitized: an unexpected adapter failure is logged server-side, never echoed to the browser. */
export const audioFileErrorResponse = (error: unknown, context: string): Response => {
  const failure = toPublicFailure(error, context)
  const status = NOT_FOUND_CODES.has(failure.code) ? 404 : 500
  return new Response(failure.message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}
