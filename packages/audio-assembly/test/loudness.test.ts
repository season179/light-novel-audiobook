import { describe, expect, it } from 'vitest'
import { AudioAssemblyError } from '../src/errors.js'
import { computeLoudnessGainDb, parseLoudnormMeasurement } from '../src/loudness.js'
import { DEFAULT_ASSEMBLY_SETTINGS } from '../src/settings.js'

const settings = DEFAULT_ASSEMBLY_SETTINGS

const loudnormOutput = (values: Readonly<Record<string, string>>): string =>
  [
    'ffmpeg version 7.0.2-static',
    '  Stream #0:0: Audio: flac, 48000 Hz, mono',
    '[Parsed_loudnorm_0 @ 0x7f] ',
    JSON.stringify(values, null, 1),
    'size=N/A time=00:00:08.50 bitrate=N/A speed=70x',
  ].join('\n')

describe('parseLoudnormMeasurement', () => {
  it('reads the measurement block out of surrounding FFmpeg log output', () => {
    const measurement = parseLoudnormMeasurement(
      loudnormOutput({
        input_i: '-22.55',
        input_tp: '-18.06',
        input_lra: '2.50',
        input_thresh: '-32.63',
        target_offset: '-0.61',
      }),
    )
    expect(measurement).toStrictEqual({
      integratedLufs: -22.55,
      truePeakDbtp: -18.06,
      loudnessRangeLu: 2.5,
    })
  })

  it('treats the silent "-inf" report as unmeasurable rather than as a number', () => {
    const measurement = parseLoudnormMeasurement(
      loudnormOutput({ input_i: '-inf', input_tp: '-inf', input_lra: '0.00' }),
    )
    expect(measurement).toStrictEqual({
      integratedLufs: null,
      truePeakDbtp: null,
      loudnessRangeLu: 0,
    })
  })

  it('fails when FFmpeg printed no measurement', () => {
    expect(() => parseLoudnormMeasurement('no json here')).toThrow(AudioAssemblyError)
    expect(() => parseLoudnormMeasurement('{"input_lra": "1.0"}')).toThrow(
      /missing input_i or input_tp/u,
    )
    expect(() => parseLoudnormMeasurement('{ not json }')).toThrow(/not valid JSON/u)
  })
})

describe('computeLoudnessGainDb', () => {
  const decide = (integratedLufs: number | null, truePeakDbtp: number | null) =>
    computeLoudnessGainDb({
      measurement: { integratedLufs, truePeakDbtp, loudnessRangeLu: 2 },
      targetLoudnessLufs: settings.targetLoudnessLufs,
      maxTruePeakDbtp: settings.maxTruePeakDbtp,
      loudnessFloorLufs: settings.loudnessFloorLufs,
    })

  it('lifts quiet material to the loudness target', () => {
    expect(decide(-22.55, -18.06)).toStrictEqual({
      gainDb: 4.55,
      limitedBy: 'loudness',
      warning: null,
    })
  })

  it('attenuates material that is louder than the target', () => {
    expect(decide(-14, -9).gainDb).toBe(-4)
  })

  it('reduces the gain when true peak headroom runs out and says so', () => {
    const decision = decide(-30, -5)
    expect(decision.gainDb).toBe(2)
    expect(decision.limitedBy).toBe('true_peak')
    expect(decision.warning).toMatch(/True peak headroom limited/u)
  })

  it('truncates the gain so a peak-limited run cannot exceed the ceiling', () => {
    // Rounding these up to 5.00 dB would put true peak above -3 dBTP.
    for (const truePeak of [-7.996, -7.9951]) {
      const decision = decide(-30, truePeak)
      expect(decision.gainDb).toBe(4.99)
      expect(decision.limitedBy).toBe('true_peak')
      expect(truePeak + decision.gainDb).toBeLessThanOrEqual(settings.maxTruePeakDbtp)
    }
  })

  it('keeps an exact hundredth of a decibel instead of truncating binary noise away', () => {
    expect(decide(-22.55, -18.06).gainDb).toBe(4.55)
    expect(decide(-18.3, -12).gainDb).toBe(0.3)
    expect(decide(-14, -9).gainDb).toBe(-4)
  })

  it('allows no boost when true peak is unknown', () => {
    // A literal "inf" true peak must not read as unlimited headroom.
    const decision = decide(-30, null)
    expect(decision.gainDb).toBe(0)
    expect(decision.limitedBy).toBe('true_peak')
    expect(
      computeLoudnessGainDb({
        measurement: {
          integratedLufs: -30,
          truePeakDbtp: parseLoudnormMeasurement(
            loudnormOutput({ input_i: '-30.00', input_tp: 'inf' }),
          ).truePeakDbtp,
          loudnessRangeLu: 1,
        },
        targetLoudnessLufs: settings.targetLoudnessLufs,
        maxTruePeakDbtp: settings.maxTruePeakDbtp,
        loudnessFloorLufs: settings.loudnessFloorLufs,
      }).gainDb,
    ).toBe(0)
    // Attenuation stays available, because reducing level cannot raise a peak.
    expect(decide(-10, null).gainDb).toBe(-8)
  })

  it('never applies gain when the material is unmeasurable', () => {
    for (const measurement of [null, -70, -80] as const) {
      const decision = decide(measurement, null)
      expect(decision.gainDb).toBe(0)
      expect(decision.limitedBy).toBe('unmeasurable')
      expect(decision.warning).toMatch(/not measurable/u)
    }
  })

  it('rounds the gain so a rerun produces the same bytes', () => {
    expect(decide(-20.123456, -12).gainDb).toBe(2.12)
  })
})
