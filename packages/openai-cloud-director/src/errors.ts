import {
  classifyDirectorError,
  DirectorError,
  DirectorFidelityError,
} from '@light-novel-audiobook/gemma-director'

/**
 * Classifies provider failures, then deliberately drops their causal objects. TanStack/OpenAI errors
 * can carry the complete provider response; retaining them would let raw cloud data reach logs or a
 * persisted failure diagnostic even when the public message is safe.
 */
export function sanitizeOpenAiCloudError(
  error: unknown,
  context: {
    readonly timedOut?: boolean
    readonly callerCancelled?: boolean
    readonly operation: string
  },
): DirectorError {
  if (error instanceof DirectorFidelityError) return error
  const classified = classifyDirectorError(error, context)
  return new DirectorError(classified.code, classified.message, classified.retryable, {
    ...(classified.status === undefined ? {} : { status: classified.status }),
  })
}

export function cloudFidelityError(error: DirectorFidelityError): DirectorFidelityError {
  return new DirectorFidelityError(
    error.findings,
    `OpenAI cloud director output failed deterministic fidelity validation (${[
      ...new Set(error.findings.map((finding) => finding.code)),
    ].join(', ')})`,
  )
}
