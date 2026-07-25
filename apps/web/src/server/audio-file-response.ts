import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import type { AudioFileDescriptor } from './audiobook-web-api.js'
import { toWebApiFailure, WebApiError } from './errors.js'

const NOT_FOUND_CODES = new Set(['unknown_job', 'unknown_upload', 'output_unavailable'])

const contentDisposition = (fileName: string, attachment: boolean): string => {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const disposition = attachment ? 'attachment' : 'inline'
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}

/** Streams a generated file from the workspace; the file is never buffered in memory. */
export const audioFileResponse = (file: AudioFileDescriptor): Response => {
  const stream = Readable.toWeb(createReadStream(file.path)) as ReadableStream<Uint8Array>
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': file.contentType,
      'Content-Length': String(file.byteLength),
      'Content-Disposition': contentDisposition(file.fileName, file.attachment),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

export const audioFileErrorResponse = (error: unknown): Response => {
  const failure = toWebApiFailure(error)
  const status = error instanceof WebApiError && NOT_FOUND_CODES.has(failure.code) ? 404 : 500
  return new Response(failure.message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}
