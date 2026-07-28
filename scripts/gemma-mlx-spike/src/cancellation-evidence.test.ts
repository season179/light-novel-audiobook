/**
 * Deterministic tests for the pure cancellation-evidence computation shared by the success and
 * failure finalize paths. These directly prove the "armed != fired" semantics required by
 * issue #106 / PR #123 blocker #2 — including the success-path case where a cancel-mode run
 * completes before the timer fires — without spawning mlx_lm.server.
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { cancellationEvidence } from './cancellation-evidence.js'

describe('cancellationEvidence', () => {
  test('ok outcome in cancel-mode (timer armed, never fired): phase=measurement, cancel_timer_fired=false, exercised=false', () => {
    const { phase, cancellation } = cancellationEvidence({
      cancelAfterMs: 30_000,
      cancelTimerFired: false,
      terminatingSignal: null,
      observedErrorCode: null,
    })

    assert.equal(phase, 'measurement')
    assert.equal(cancellation.cancel_requested, true)
    assert.equal(cancellation.cancel_after_ms, 30_000)
    assert.equal(cancellation.cancel_timer_fired, false)
    assert.equal(cancellation.request_cancellation_signal_fired, false)
    assert.equal(cancellation.exercised, false)
    assert.equal(cancellation.observed_error_code, null)
  })

  test('gate failure in cancel-mode before the timer (the ~18.6s scenario): phase=measurement, observed_error_code=malformed_output, exercised=false', () => {
    const { phase, cancellation } = cancellationEvidence({
      cancelAfterMs: 30_000,
      cancelTimerFired: false,
      terminatingSignal: null,
      observedErrorCode: 'malformed_output',
    })

    assert.equal(phase, 'measurement')
    assert.equal(cancellation.cancel_requested, true)
    assert.equal(cancellation.cancel_timer_fired, false)
    assert.equal(cancellation.exercised, false)
    assert.equal(cancellation.observed_error_code, 'malformed_output')
  })

  test('cancel timer actually fired: phase=cancellation, cancel_timer_fired=true, exercised=true', () => {
    const { phase, cancellation } = cancellationEvidence({
      cancelAfterMs: 30_000,
      cancelTimerFired: true,
      terminatingSignal: null,
      observedErrorCode: 'cancelled',
    })

    assert.equal(phase, 'cancellation')
    assert.equal(cancellation.cancel_timer_fired, true)
    assert.equal(cancellation.exercised, true)
    assert.equal(cancellation.observed_error_code, 'cancelled')
  })

  test('terminating signal fired without the cancel timer: phase=cancellation, exercised=true, cancel_timer_fired=false', () => {
    const { phase, cancellation } = cancellationEvidence({
      cancelAfterMs: undefined,
      cancelTimerFired: false,
      terminatingSignal: 'SIGTERM',
      observedErrorCode: 'cancelled',
    })

    assert.equal(phase, 'cancellation')
    assert.equal(cancellation.cancel_timer_fired, false)
    assert.equal(cancellation.request_cancellation_signal_fired, true)
    assert.equal(cancellation.terminating_signal, 'SIGTERM')
    assert.equal(cancellation.exercised, true)
  })

  test('plain measurement (no cancel flag, no signal): phase=measurement, exercised=false', () => {
    const { phase, cancellation } = cancellationEvidence({
      cancelAfterMs: undefined,
      cancelTimerFired: false,
      terminatingSignal: null,
      observedErrorCode: null,
    })

    assert.equal(phase, 'measurement')
    assert.equal(cancellation.cancel_requested, false)
    assert.equal(cancellation.cancel_after_ms, null)
    assert.equal(cancellation.exercised, false)
  })
})
