import type { ChildProcess } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canonicalSha256,
  type EvaluationSource,
  type GoldAnnotations,
  type RepresentativeCorpus,
} from '@light-novel-audiobook/scoring-harness'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { GatewayResponse, ModelGateway } from '../src/gateway.js'
import { runExactlyThree } from '../src/orchestrator.js'
import { BENCHMARK_PROFILES, enforceFallbackOrder, profileById } from '../src/profiles.js'
import { prepareRequest } from '../src/prompt.js'
import type { HostManifest } from '../src/runtime.js'
import { type BenchmarkContext, benchmarkContextSchema } from '../src/schemas.js'
import type { ValidatedInputs } from '../src/workspace.js'

const fixtureRoot = join(import.meta.dirname, '../../scoring-harness/test/fixtures')
const temporaryRoots: string[] = []

async function fixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(fixtureRoot, name), 'utf8')) as T
}

async function contextFixture(): Promise<BenchmarkContext> {
  return benchmarkContextSchema.parse(
    JSON.parse(
      await readFile(join(import.meta.dirname, 'fixtures/synthetic-context.json'), 'utf8'),
    ),
  )
}

class PassingGateway implements ModelGateway {
  completeCalls = 0

  constructor(
    private readonly corpus: RepresentativeCorpus,
    private readonly annotations: GoldAnnotations,
  ) {}

  async countTokens(): Promise<number> {
    return 1_000
  }

  async complete(): Promise<GatewayResponse> {
    this.completeCalls += 1
    const gold = new Map(this.annotations.cases.map((item) => [item.case_id, item]))
    const results = this.corpus.cases.map((item) => {
      const annotation = gold.get(item.case_id)
      if (!annotation) throw new Error('fixture mismatch')
      const ambiguous =
        annotation.speaker.status === 'ambiguous' || annotation.speaker.status === 'unresolved'
      return {
        case_id: item.case_id,
        status: 'predicted',
        kind: annotation.kind,
        speaker:
          annotation.speaker.status === 'exact'
            ? annotation.speaker.accepted_character_ids[0]
            : annotation.kind === 'dialogue'
              ? 'fallback-dialogue'
              : 'narrator',
        review_required: ambiguous || item.criteria.includes('structurally_ambiguous'),
      }
    })
    const body = {
      choices: [{ message: { content: JSON.stringify({ results }) } }],
      timings: {
        prompt_n: 100,
        predicted_n: 50,
        prompt_per_second: 10,
        predicted_per_second: 5,
      },
    }
    return {
      ok: true,
      status: 200,
      raw: JSON.stringify(body),
      json: body,
      resources: { elapsedMs: 1_000, peakVramMib: 10_000, peakRamMib: 20_000 },
    }
  }
}

const host: HostManifest = {
  schemaVersion: 1,
  llamaCommit: '5'.repeat(40),
  binarySha256: '6'.repeat(64),
  modelRevision: 'd1c082be9cf3c8a514acf63b8761f4b41935842e',
  modelSha256: '3eca3b8f6d7baf218a7dd6bba5fb59a56ee25fe2d567b6f5f589b4f697eca51d',
  modelSizeBytes: 14_439_363_584,
  cudaCompiler: 'synthetic CUDA',
  cmakeConfigurationSha256: '7'.repeat(64),
  cleanSourceCheckout: true,
  cleanRebuild: true,
  textModelOnly: true,
}

async function inputs(root: string): Promise<ValidatedInputs> {
  const source = await fixture<EvaluationSource>('source.json')
  const corpus = await fixture<RepresentativeCorpus>('corpus.json')
  const annotations = await fixture<GoldAnnotations>('annotations.json')
  return {
    workspaceRoot: root,
    source,
    corpus,
    annotations,
    context: await contextFixture(),
    sourceSha256: canonicalSha256(source),
    corpusSha256: canonicalSha256(corpus),
  }
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('Gemma benchmark policy', () => {
  it('enforces the exact fallback order and special first fallback reason', () => {
    const primary = profileById(BENCHMARK_PROFILES[0]?.id ?? '')
    expect(() => enforceFallbackOrder(primary, undefined)).not.toThrow()
    const first = profileById(BENCHMARK_PROFILES[1]?.id ?? '')
    expect(() =>
      enforceFallbackOrder(first, {
        schema_version: 'fallback-history@1',
        attempts: [
          {
            profile_id: primary.id,
            report_sha256: 'a'.repeat(64),
            overall_passed: false,
            reason: 'acceptance_failed',
          },
        ],
      }),
    ).toThrow()
    expect(() =>
      enforceFallbackOrder(first, {
        schema_version: 'fallback-history@1',
        attempts: [
          {
            profile_id: primary.id,
            report_sha256: 'a'.repeat(64),
            overall_passed: false,
            reason: 'mature_content_refusal',
          },
        ],
      }),
    ).not.toThrow()
  })

  it('keeps the committed private-context JSON Schema synchronized', async () => {
    const committed = JSON.parse(
      await readFile(
        join(import.meta.dirname, '../../../schemas/evaluation/benchmark-context.schema.json'),
        'utf8',
      ),
    ) as Record<string, unknown>
    const generated = z.toJSONSchema(benchmarkContextSchema, {
      target: 'draft-2020-12',
      io: 'input',
    }) as Record<string, unknown>
    generated.$id = 'https://local.invalid/light-novel-audiobook/evaluation/benchmark-context@1'
    expect(committed).toEqual(generated)
  })

  it('builds deterministic blind requests without corpus criteria or gold', async () => {
    const source = await fixture<EvaluationSource>('source.json')
    const corpus = await fixture<RepresentativeCorpus>('corpus.json')
    const context = await contextFixture()
    const profile = BENCHMARK_PROFILES[0]
    if (!profile) throw new Error('missing profile')
    const left = prepareRequest(source, corpus, context, profile.id, profile)
    const right = prepareRequest(source, corpus, context, profile.id, profile)
    expect(left).toEqual(right)
    const wire = JSON.stringify(left.body)
    expect(wire).not.toContain('structurally_ambiguous')
    expect(wire).not.toContain('accepted_character_ids')
    expect(profile.contextSize).toBe(32_768)
    expect(profile.gpuLayers).toBe(35)
  })

  it('keeps committed host smoke evidence synthetic-only and text-free', async () => {
    const evidenceText = await readFile(
      join(import.meta.dirname, '../evidence/synthetic-operational-smoke.json'),
      'utf8',
    )
    const evidence = JSON.parse(evidenceText)
    expect(evidence.dataset_class).toBe('synthetic_operational')
    expect(evidence.representative_accuracy_claim_permitted).toBe(false)
    expect(evidence.run_count).toBe(3)
    expect(evidence.decision).toBe('synthetic-operational-smoke-only')
    expect(evidence.scoring.metrics.operational_success.passed).toBe(true)
    expect(evidence.scoring.metrics.context_size_configuration.passed).toBe(true)
    expect(evidenceText).not.toContain('The brass bell rang.')
  })

  it('creates exactly three immutable runs, scores them, and resumes without rerunning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gemma-benchmark-'))
    temporaryRoots.push(root)
    const validated = await inputs(root)
    const gateway = new PassingGateway(validated.corpus, validated.annotations)
    const child = { exitCode: null, signalCode: null } as unknown as ChildProcess
    const profile = BENCHMARK_PROFILES[0]
    if (!profile) throw new Error('missing profile')
    const options = {
      experimentId: 'synthetic-resume',
      datasetClass: 'synthetic_operational' as const,
      inputs: validated,
      profile,
      host,
      gateway,
      child,
    }
    const first = await runExactlyThree(options)
    expect(first.overallPassed).toBe(true)
    expect(first.operationalPassed).toBe(true)
    expect(gateway.completeCalls).toBe(3)
    await runExactlyThree(options)
    expect(gateway.completeCalls).toBe(3)
    const report = await readFile(first.reportPath, 'utf8')
    expect(report).toContain('synthetic-operational-smoke-only')
    expect(report).not.toContain('The brass bell rang.')
    await expect(
      readFile(join(root, 'experiments/synthetic-resume/run-4.private.json'), 'utf8'),
    ).rejects.toThrow()
  })
})
