import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { canonicalJson, type JsonValue } from '../src/canonical-json.js'
import { evaluationReportSchema } from '../src/schemas.js'
import {
  GovernanceValidationError,
  RepresentativeCorpusScorer,
  type ScoringInputs,
} from '../src/scorer.js'

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

async function json(filename: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(fixtureRoot, filename), 'utf8')) as unknown
}

async function fixture(): Promise<ScoringInputs> {
  return {
    source: await json('source.json'),
    corpus: await json('corpus.json'),
    annotations: await json('annotations.json'),
    runs: await Promise.all([json('run-1.json'), json('run-2.json'), json('run-3.json')]),
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function mutableRuns(inputs: ScoringInputs): Record<string, unknown>[] {
  return clone(inputs.runs) as Record<string, unknown>[]
}

function runAt(runs: Record<string, unknown>[], index: number): Record<string, unknown> {
  const run = runs[index]
  if (!run) throw new Error(`Missing test run ${index}`)
  return run
}

function predictions(run: Record<string, unknown>): Record<string, unknown>[] {
  return run.predictions as Record<string, unknown>[]
}

function predictionAt(run: Record<string, unknown>, index: number): Record<string, unknown> {
  const prediction = predictions(run)[index]
  if (!prediction) throw new Error(`Missing test prediction ${index}`)
  return prediction
}

function score(inputs: ScoringInputs) {
  return new RepresentativeCorpusScorer().score(inputs)
}

describe('representative corpus scorer', () => {
  it('reproduces the committed report and records all locked boundary metrics', async () => {
    const inputs = await fixture()
    const first = score(inputs)
    const second = score(inputs)
    const expected = await json('expected-report.json')

    expect(first).toEqual(expected)
    expect(canonicalJson(first as unknown as JsonValue)).toBe(
      canonicalJson(second as unknown as JsonValue),
    )
    expect(evaluationReportSchema.parse(first)).toEqual(first)
    expect(first.overall_passed).toBe(true)
    expect(first.metrics.dialogue_speaker_accuracy?.rate).toBe('0.950000')
    expect(first.metrics.alias_coreference_accuracy?.rate).toBe('0.950000')
    expect(first.metrics.thought_vs_spoken_accuracy?.rate).toBe('0.980000')
    expect(first.metrics.elapsed_time_within_limit?.passed).toBe(true)
    expect(first.metrics.vram_within_limit?.passed).toBe(true)
    expect(first.metrics.ram_within_limit?.passed).toBe(true)
    expect(first.metrics.operational_success?.passed).toBe(true)

    const source = inputs.source as { passages: { source_text: string; locator: string }[] }
    const serializedReport = JSON.stringify(first)
    for (const passage of source.passages) {
      expect(serializedReport).not.toContain(passage.source_text)
      expect(serializedReport).not.toContain(passage.locator)
    }
  })

  it('fails just below the speaker and thought/spoken thresholds', async () => {
    const inputs = await fixture()
    const speakerRuns = mutableRuns(inputs)
    predictionAt(runAt(speakerRuns, 0), 1).speaker = 'another-wrong-character'
    const speakerReport = score({ ...inputs, runs: speakerRuns })
    expect(speakerReport.metrics.dialogue_speaker_accuracy?.rate).toBe('0.933333')
    expect(speakerReport.metrics.dialogue_speaker_accuracy?.passed).toBe(false)
    expect(speakerReport.metrics.alias_coreference_accuracy?.passed).toBe(false)

    const kindRuns = mutableRuns(inputs)
    predictionAt(runAt(kindRuns, 0), 22).kind = 'dialogue'
    const kindReport = score({ ...inputs, runs: kindRuns })
    expect(kindReport.metrics.thought_vs_spoken_accuracy?.rate).toBe('0.973333')
    expect(kindReport.metrics.thought_vs_spoken_accuracy?.passed).toBe(false)
  })

  it('uses an exact rational 90% review-recall boundary', async () => {
    const inputs = await fixture()
    const runsAtBoundary = mutableRuns(inputs)
    const additionalErrors = [
      [0, 1],
      [0, 2],
      [0, 3],
      [1, 1],
      [1, 2],
      [2, 1],
      [2, 2],
    ] as const
    for (const [runIndex, predictionIndex] of additionalErrors) {
      const prediction = predictionAt(runAt(runsAtBoundary, runIndex), predictionIndex)
      prediction.speaker = 'known-wrong-character'
      prediction.review_required = true
    }
    predictionAt(runAt(runsAtBoundary, 2), 2).review_required = false

    const boundary = score({ ...inputs, runs: runsAtBoundary })
    expect(boundary.metrics.incorrect_speaker_review_recall?.numerator).toBe(9)
    expect(boundary.metrics.incorrect_speaker_review_recall?.denominator).toBe(10)
    expect(boundary.metrics.incorrect_speaker_review_recall?.passed).toBe(true)

    const runsBelow = clone(runsAtBoundary)
    predictionAt(runAt(runsBelow, 2), 1).review_required = false
    const below = score({ ...inputs, runs: runsBelow })
    expect(below.metrics.incorrect_speaker_review_recall?.rate).toBe('0.800000')
    expect(below.metrics.incorrect_speaker_review_recall?.passed).toBe(false)
  })

  it('applies the 95% joint three-run agreement boundary', async () => {
    const inputs = await fixture()
    const atBoundary = mutableRuns(inputs)
    for (const predictionIndex of [50, 51, 52]) {
      predictionAt(runAt(atBoundary, 2), predictionIndex).speaker = 'variant'
    }
    const boundary = score({ ...inputs, runs: atBoundary })
    expect(boundary.metrics.three_run_agreement?.rate).toBe('0.950000')
    expect(boundary.metrics.three_run_agreement?.passed).toBe(true)

    const belowBoundary = clone(atBoundary)
    predictionAt(runAt(belowBoundary, 2), 53).speaker = 'variant'
    const below = score({ ...inputs, runs: belowBoundary })
    expect(below.metrics.three_run_agreement?.rate).toBe('0.933333')
    expect(below.metrics.three_run_agreement?.passed).toBe(false)
  })

  it('does not deduplicate repeated text or two source spans from one passage', async () => {
    const inputs = await fixture()
    const runs = mutableRuns(inputs)
    predictions(runAt(runs, 0)).splice(1, 1)
    const report = score({ ...inputs, runs })

    expect(report.metrics.exact_source_coverage?.passed).toBe(false)
    expect(report.metrics.exact_source_coverage?.numerator).toBe(176)
    expect(report.findings.some((finding) => finding.code === 'source-coverage-failed')).toBe(true)
    expect(JSON.stringify(report)).not.toContain('The brass bell rang.')
  })

  it('rejects altered text and invented source references without reporting their text', async () => {
    const inputs = await fixture()
    const alteredRuns = mutableRuns(inputs)
    predictionAt(runAt(alteredRuns, 0), 2).text = 'invented replacement text'
    const altered = score({ ...inputs, runs: alteredRuns })
    expect(altered.metrics.exact_source_coverage?.passed).toBe(false)
    expect(JSON.stringify(altered)).not.toContain('invented replacement text')

    const unknownRuns = mutableRuns(inputs)
    predictions(runAt(unknownRuns, 0)).push({
      source_ref: 'invented-source-reference',
      source_start: 0,
      source_end: 1,
      status: 'predicted',
      text: 'invented story text',
      kind: 'narration',
      speaker: 'narrator',
      review_required: false,
    })
    const unknown = score({ ...inputs, runs: unknownRuns })
    expect(unknown.metrics.exact_source_coverage?.passed).toBe(false)
    expect(unknown.findings.some((finding) => finding.code === 'unknown-source-reference')).toBe(
      true,
    )
    expect(JSON.stringify(unknown)).not.toContain('invented story text')
  })

  it('fails closed for malformed output, refusal, and operational values above each limit', async () => {
    const inputs = await fixture()

    const malformedRuns = mutableRuns(inputs)
    runAt(malformedRuns, 0).unexpected = true
    const malformed = score({ ...inputs, runs: malformedRuns })
    expect(malformed.metrics.schema_validity?.passed).toBe(false)
    expect(malformed.overall_passed).toBe(false)
    expect(evaluationReportSchema.safeParse(malformed).success).toBe(true)

    const refusalRuns = mutableRuns(inputs)
    const refused = predictionAt(runAt(refusalRuns, 0), 10)
    for (const key of ['text', 'kind', 'speaker']) delete refused[key]
    refused.status = 'refused'
    refused.refusal_code = 'content'
    refused.review_required = true
    const refusal = score({ ...inputs, runs: refusalRuns })
    expect(refusal.metrics.refusal_rate?.passed).toBe(false)

    for (const [field, metricName] of [
      ['elapsed_ms', 'elapsed_time_within_limit'],
      ['peak_vram_mib', 'vram_within_limit'],
      ['peak_ram_mib', 'ram_within_limit'],
    ] as const) {
      const resourceRuns = mutableRuns(inputs)
      const operational = runAt(resourceRuns, 0).operational as Record<string, number>
      operational[field] = (operational[field] ?? 0) + 1
      const report = score({ ...inputs, runs: resourceRuns })
      expect(report.metrics[metricName]?.passed).toBe(false)
    }

    const crashedRuns = mutableRuns(inputs)
    ;(runAt(crashedRuns, 0).operational as Record<string, unknown>).crashed = true
    expect(score({ ...inputs, runs: crashedRuns }).metrics.operational_success?.passed).toBe(false)

    const oomRuns = mutableRuns(inputs)
    ;(runAt(oomRuns, 0).operational as Record<string, unknown>).out_of_memory = true
    expect(score({ ...inputs, runs: oomRuns }).metrics.operational_success?.passed).toBe(false)

    const contextRuns = mutableRuns(inputs)
    const model = runAt(contextRuns, 0).model as Record<string, number>
    model.context_size = 32_769
    expect(score({ ...inputs, runs: contextRuns }).metrics.context_size_configuration?.passed).toBe(
      false,
    )

    const ambiguityRuns = mutableRuns(inputs)
    predictionAt(runAt(ambiguityRuns, 0), 20).review_required = false
    expect(
      score({ ...inputs, runs: ambiguityRuns }).metrics.ambiguity_review_coverage?.passed,
    ).toBe(false)
  })

  it('rejects tampered governance and unsafe committed-private classification', async () => {
    const inputs = await fixture()
    const tamperedSource = clone(inputs.source) as {
      passages: { source_text: string }[]
    }
    const firstPassage = tamperedSource.passages[0]
    if (!firstPassage) throw new Error('Missing test passage')
    firstPassage.source_text = 'tampered private text'
    expect(() => score({ ...inputs, source: tamperedSource })).toThrow(GovernanceValidationError)

    const privateSource = clone(inputs.source) as {
      provenance: { origin: string; redistribution: string }
    }
    privateSource.provenance.origin = 'private_copyrighted'
    privateSource.provenance.redistribution = 'workspace_only'
    expect(() => score({ ...inputs, source: privateSource })).toThrow(
      /private-source-must-use-workspace-storage|hash-mismatch/,
    )
  })
})
