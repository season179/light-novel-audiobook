/**
 * Pure, side-effect-free computation of cancellation evidence shared by the success and failure
 * finalize paths in spike.ts. Extracted to its own module so the phase/section logic (the heart
 * of issue #106 / PR #123 blocker #2 and the "armed != fired" requirement) is unit-testable
 * without spawning mlx_lm.server.
 *
 * `phase` is 'cancellation' only when a cancellation mechanism actually fired (the
 * --cancel-after-ms timer callback executed, or a terminating signal was received) — never merely
 * because the flag was supplied. `exercised` follows the same rule. A 30s timer on a run that
 * ends at ~18.6s therefore yields phase='measurement', cancel_timer_fired=false, exercised=false.
 */
export type CancellationPhase = 'measurement' | 'cancellation'

export interface CancellationEvidenceInput {
  readonly cancelAfterMs: number | undefined
  readonly cancelTimerFired: boolean
  readonly terminatingSignal: string | null
  readonly observedErrorCode: string | null
}

export interface CancellationSection {
  readonly cancel_requested: boolean
  readonly cancel_after_ms: number | null
  readonly cancel_timer_fired: boolean
  readonly request_cancellation_signal_fired: boolean
  readonly terminating_signal: string | null
  readonly exercised: boolean
  readonly observed_error_code: string | null
}

export interface CancellationEvidence {
  readonly phase: CancellationPhase
  readonly cancellation: CancellationSection
}

export function cancellationEvidence(input: CancellationEvidenceInput): CancellationEvidence {
  const exercised = input.cancelTimerFired || input.terminatingSignal !== null
  return {
    phase: exercised ? 'cancellation' : 'measurement',
    cancellation: {
      cancel_requested: input.cancelAfterMs !== undefined,
      cancel_after_ms: input.cancelAfterMs ?? null,
      cancel_timer_fired: input.cancelTimerFired,
      request_cancellation_signal_fired: input.terminatingSignal !== null,
      terminating_signal: input.terminatingSignal,
      exercised,
      observed_error_code: input.observedErrorCode,
    },
  }
}
