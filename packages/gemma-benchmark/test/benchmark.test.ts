import type { ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canonicalJson,
  canonicalSha256,
  type EvaluationSource,
  type GoldAnnotations,
  type JsonValue,
  type RepresentativeCorpus,
  sha256,
} from '@light-novel-audiobook/scoring-harness'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { GatewayCompletion, ModelGateway } from '../src/gateway.js'
import { operationalRunSetPassed, runExactlyThree } from '../src/orchestrator.js'
import { BENCHMARK_PROFILES, enforceFallbackOrder } from '../src/profiles.js'
import { prepareRequest } from '../src/prompt.js'
import type { HostManifest, PinnedRuntimeContext } from '../src/runtime.js'
import {
  type BenchmarkContext,
  benchmarkContextSchema,
  type ResourceCapture,
} from '../src/schemas.js'
import { syntheticOperationalStatus } from '../src/status.js'
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

const completeResources: ResourceCapture = {
  method_version: 'wsl-system-resource-sampling@2',
  elapsed_ms: 1_000,
  peak_vram_mib: 10_000,
  peak_ram_mib: 20_000,
  sample_count: 3,
  initial_sample_captured: true,
  final_sample_captured: true,
  complete: true,
  error_code: 'none',
}

class PassingGateway implements ModelGateway {
  completeCalls = 0
  tokenCalls = 0

  constructor(
    private readonly corpus: RepresentativeCorpus,
    private readonly annotations: GoldAnnotations,
    private readonly mutate?: (completion: GatewayCompletion, call: number) => GatewayCompletion,
  ) {}

  async countTokens(): Promise<number> {
    this.tokenCalls += 1
    return 1_000
  }

  async complete(): Promise<GatewayCompletion> {
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
    const completion: GatewayCompletion = {
      response: {
        ok: true,
        status: 200,
        raw: JSON.stringify(body),
        json: body,
        jsonValid: true,
      },
      failure: 'none',
      resources: completeResources,
    }
    return this.mutate?.(completion, this.completeCalls) ?? completion
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

function runtime(child?: ChildProcess): PinnedRuntimeContext {
  return {
    host,
    hostManifestSha256: '8'.repeat(64),
    runtimeConfigurationSha256: '9'.repeat(64),
    externalRootProof: {
      schemaVersion: 2,
      canonicalized: true,
      filesystem: 'ext4',
      outsideRepository: true,
      outsideGitDirectory: true,
      outsideTtsRoots: true,
      overlapCheckedBothDirections: true,
      symlinkComponentsRejected: true,
      pathClasses: ['binary', 'manifest', 'model', 'runtime', 'temporary'],
    },
    child: child ?? ({ exitCode: null, signalCode: null } as unknown as ChildProcess),
  }
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
    sourceSha256: canonicalSha256(source as unknown as JsonValue),
    corpusSha256: canonicalSha256(corpus as unknown as JsonValue),
    annotationsSha256: canonicalSha256(annotations as unknown as JsonValue),
  }
}

async function temporaryInput(): Promise<{ root: string; inputs: ValidatedInputs }> {
  const root = await mkdtemp(join(tmpdir(), 'gemma-benchmark-'))
  temporaryRoots.push(root)
  return { root, inputs: await inputs(root) }
}

function optionsFor(
  validated: ValidatedInputs,
  gateway: ModelGateway,
  experimentId: string,
  runtimeContext = runtime(),
) {
  const profile = BENCHMARK_PROFILES[0]
  if (!profile) throw new Error('missing profile')
  return {
    experimentId,
    datasetClass: 'synthetic_operational' as const,
    inputs: validated,
    profile,
    runtime: runtimeContext,
    gateway,
  }
}

async function writeCanonical(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${canonicalJson(value as JsonValue)}\n`)
}

async function currentLinuxIdentity(): Promise<{ startTimeTicks: string; executable: string }> {
  const statBytes = await readFile(`/proc/${process.pid}/stat`, 'utf8')
  const commandEnd = statBytes.lastIndexOf(')')
  const startTimeTicks = statBytes
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/)[19]
  if (!startTimeTicks) throw new Error('missing test process start time')
  return { startTimeTicks, executable: await readlink(`/proc/${process.pid}/exe`) }
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('Gemma benchmark policy', () => {
  it('enforces every fallback transitively with no skipped or mislabeled predecessor', () => {
    const [primary, first, second, third] = BENCHMARK_PROFILES
    if (!primary || !first || !second || !third) throw new Error('missing profiles')
    expect(() => enforceFallbackOrder(primary, undefined)).not.toThrow()
    expect(() =>
      enforceFallbackOrder(first, {
        schema_version: 'fallback-history@2',
        attempts: [
          {
            profile_id: primary.id,
            report_sha256: 'a'.repeat(64),
            overall_passed: false,
            evaluation_reason: 'primary_locked',
            failure_reasons: ['mature_content_refusal'],
          },
        ],
      }),
    ).not.toThrow()
    expect(() =>
      enforceFallbackOrder(first, {
        schema_version: 'fallback-history@2',
        attempts: [
          {
            profile_id: primary.id,
            report_sha256: 'd'.repeat(64),
            overall_passed: false,
            evaluation_reason: 'primary_locked',
            failure_reasons: ['acceptance_failed'],
          },
        ],
      }),
    ).toThrow('primary report')
    const orderTwoHistory = {
      schema_version: 'fallback-history@2' as const,
      attempts: [
        {
          profile_id: primary.id,
          report_sha256: 'a'.repeat(64),
          overall_passed: false as const,
          evaluation_reason: 'primary_locked' as const,
          failure_reasons: ['mature_content_refusal' as const],
        },
        {
          profile_id: first.id,
          report_sha256: 'b'.repeat(64),
          overall_passed: false as const,
          evaluation_reason: 'mature_content_refusal' as const,
          failure_reasons: ['operational_impractical' as const],
        },
      ],
    }
    const primaryAttempt = orderTwoHistory.attempts[0]
    const firstAttempt = orderTwoHistory.attempts[1]
    if (!primaryAttempt || !firstAttempt) throw new Error('missing fallback attempts')
    expect(() => enforceFallbackOrder(second, orderTwoHistory)).not.toThrow()
    expect(() =>
      enforceFallbackOrder(second, {
        ...orderTwoHistory,
        attempts: [
          primaryAttempt,
          { ...firstAttempt, report_sha256: primaryAttempt.report_sha256 },
        ],
      }),
    ).toThrow('distinct')
    expect(() =>
      enforceFallbackOrder(second, {
        ...orderTwoHistory,
        attempts: orderTwoHistory.attempts.slice(1),
      }),
    ).toThrow()
    expect(() =>
      enforceFallbackOrder(second, {
        ...orderTwoHistory,
        attempts: [{ ...primaryAttempt, failure_reasons: ['acceptance_failed'] }, firstAttempt],
      }),
    ).toThrow('primary report')
    expect(() =>
      enforceFallbackOrder(second, {
        ...orderTwoHistory,
        attempts: [primaryAttempt, { ...firstAttempt, failure_reasons: ['acceptance_failed'] }],
      }),
    ).toThrow('operational impracticality')
    expect(() =>
      enforceFallbackOrder(second, {
        ...orderTwoHistory,
        attempts: [primaryAttempt, { ...firstAttempt, evaluation_reason: 'ordered_fallback' }],
      }),
    ).toThrow('evaluation reason')
    expect(() =>
      enforceFallbackOrder(third, {
        ...orderTwoHistory,
        attempts: [
          ...orderTwoHistory.attempts,
          {
            profile_id: second.id,
            report_sha256: 'c'.repeat(64),
            overall_passed: false,
            evaluation_reason: 'ordered_fallback',
            failure_reasons: ['acceptance_failed'],
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

  it('requires all three valid, failure-free runs for operational pass', async () => {
    const { inputs: validated } = await temporaryInput()
    const passing = new PassingGateway(validated.corpus, validated.annotations)
    const result = await runExactlyThree(optionsFor(validated, passing, 'three-valid-runs'))
    expect(result.operationalPassed).toBe(true)
    expect(result.overallPassed).toBe(true)
    expect(passing.completeCalls).toBe(3)

    const report = JSON.parse(await readFile(result.reportPath, 'utf8'))
    expect(report.operational_passed).toBe(true)
    expect(report.runs.every((run: { failure_code: string }) => run.failure_code === 'none')).toBe(
      true,
    )
  })

  it.each([
    {
      name: 'timeout',
      mutate: (completion: GatewayCompletion) => ({
        ...completion,
        response: null,
        failure: 'timeout' as const,
      }),
      failure: 'timeout',
    },
    {
      name: 'invalid provider output',
      mutate: (completion: GatewayCompletion) => ({
        ...completion,
        response: {
          ok: true,
          status: 200,
          raw: '{"choices":[]}',
          json: { choices: [] },
          jsonValid: true,
        },
      }),
      failure: 'schema',
    },
    {
      name: 'resource capture failure',
      mutate: (completion: GatewayCompletion) => ({
        ...completion,
        resources: {
          ...completeResources,
          complete: false,
          final_sample_captured: false,
          error_code: 'collector_failed' as const,
        },
      }),
      failure: 'resource_capture',
    },
    {
      name: 'OOM response',
      mutate: (completion: GatewayCompletion) => ({
        ...completion,
        response: {
          ok: false,
          status: 500,
          raw: '{"error":"CUDA out of memory"}',
          json: { error: 'CUDA out of memory' },
          jsonValid: true,
        },
      }),
      failure: 'oom',
    },
  ])('fails operational status for $name while retaining three run records', async (testCase) => {
    const { inputs: validated } = await temporaryInput()
    const gateway = new PassingGateway(validated.corpus, validated.annotations, testCase.mutate)
    const result = await runExactlyThree(
      optionsFor(validated, gateway, `failed-${testCase.failure}`),
    )
    expect(result.operationalPassed).toBe(false)
    const report = JSON.parse(await readFile(result.reportPath, 'utf8'))
    expect(report.decision).toBe('synthetic-operational-smoke-failed')
    expect(report.runs).toHaveLength(3)
    expect(
      report.runs.every((run: { failure_code: string }) => run.failure_code === testCase.failure),
    ).toBe(true)
  })

  it('fails when the child exits even after a syntactically valid provider response', async () => {
    const { inputs: validated } = await temporaryInput()
    const child = { exitCode: 137, signalCode: null } as unknown as ChildProcess
    const gateway = new PassingGateway(validated.corpus, validated.annotations)
    const result = await runExactlyThree(
      optionsFor(validated, gateway, 'child-exit', runtime(child)),
    )
    expect(result.operationalPassed).toBe(false)
    const run = JSON.parse(
      await readFile(join(result.experimentRoot, 'run-1.private.json'), 'utf8'),
    )
    expect(run.provider_output_valid).toBe(true)
    expect(run.failure_code).toBe('runtime_exit')
    expect(run.child_exit.observed_exited).toBe(true)
    expect(run.evaluation_run.operational.crashed).toBe(true)
  })

  it('resumes valid exact runs without rerunning and rejects an exclusive concurrent lock', async () => {
    const { inputs: validated } = await temporaryInput()
    const gateway = new PassingGateway(validated.corpus, validated.annotations)
    const options = optionsFor(validated, gateway, 'strict-resume')
    const first = await runExactlyThree(options)
    expect(first.operationalPassed).toBe(true)
    await runExactlyThree(options)
    expect(gateway.completeCalls).toBe(3)

    let releaseToken!: () => void
    let tokenStarted!: () => void
    const tokenStartedPromise = new Promise<void>((resolvePromise) => {
      tokenStarted = resolvePromise
    })
    const releasePromise = new Promise<void>((resolvePromise) => {
      releaseToken = resolvePromise
    })
    const blockingGateway: ModelGateway = {
      async countTokens() {
        tokenStarted()
        await releasePromise
        return 1_000
      },
      async complete() {
        throw new Error('not reached')
      },
    }
    const lockedOptions = optionsFor(validated, blockingGateway, 'exclusive-lock')
    const owner = runExactlyThree(lockedOptions)
    await tokenStartedPromise
    await expect(runExactlyThree(lockedOptions)).rejects.toThrow('already locked')
    releaseToken()
    await owner
  })

  it.each([
    { name: 'dead PID', pid: 2_147_483_647, startTimeTicks: '1', useCurrentExecutable: false },
    {
      name: 'reused PID identity',
      pid: process.pid,
      startTimeTicks: '0',
      useCurrentExecutable: true,
    },
  ])('reclaims a stale crash lock with $name without signaling any process', async (testCase) => {
    const { root, inputs: validated } = await temporaryInput()
    const identity = await currentLinuxIdentity()
    const experimentId = `stale-lock-${testCase.pid}`
    const experimentRoot = join(root, 'experiments', experimentId)
    await mkdir(experimentRoot, { recursive: true, mode: 0o700 })
    await writeCanonical(join(experimentRoot, '.experiment.lock'), {
      schema_version: 'benchmark-experiment-lock@1',
      pid: testCase.pid,
      linux_start_time_ticks: testCase.startTimeTicks,
      executable: testCase.useCurrentExecutable ? identity.executable : '/stale/benchmark',
      owner_token: 'a'.repeat(64),
    })
    const kill = vi.spyOn(process, 'kill')
    try {
      const gateway = new PassingGateway(validated.corpus, validated.annotations)
      const result = await runExactlyThree(optionsFor(validated, gateway, experimentId))
      expect(result.operationalPassed).toBe(true)
      expect(kill).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
    }
  })

  it('allows exactly one owner when 32 acquisitions race from a stale lock', async () => {
    const { root, inputs: validated } = await temporaryInput()
    const identity = await currentLinuxIdentity()
    const experimentId = 'concurrent-stale-lock-stress'
    const experimentRoot = join(root, 'experiments', experimentId)
    await mkdir(experimentRoot, { recursive: true, mode: 0o700 })
    await writeCanonical(join(experimentRoot, '.experiment.lock'), {
      schema_version: 'benchmark-experiment-lock@1',
      pid: 2_147_483_647,
      linux_start_time_ticks: '1',
      executable: identity.executable,
      owner_token: 'b'.repeat(64),
    })

    let releaseOwner!: () => void
    let rejectCount = 0
    let ownerCount = 0
    let allLosersObserved!: () => void
    let ownerObserved!: () => void
    const releaseOwnerPromise = new Promise<void>((resolvePromise) => {
      releaseOwner = resolvePromise
    })
    const allLosersObservedPromise = new Promise<void>((resolvePromise) => {
      allLosersObserved = resolvePromise
    })
    const ownerObservedPromise = new Promise<void>((resolvePromise) => {
      ownerObserved = resolvePromise
    })
    const racingGateway: ModelGateway = {
      async countTokens() {
        ownerCount += 1
        ownerObserved()
        await releaseOwnerPromise
        return 1_000
      },
      async complete() {
        throw new Error('not reached')
      },
    }
    const attempts = Array.from({ length: 32 }, () =>
      runExactlyThree(optionsFor(validated, racingGateway, experimentId)).catch(
        (error: unknown) => {
          rejectCount += 1
          if (rejectCount === 31) allLosersObserved()
          throw error
        },
      ),
    )
    const allResults = Promise.allSettled(attempts)
    let timeout: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        Promise.all([allLosersObservedPromise, ownerObservedPromise]),
        new Promise<void>((_, rejectPromise) => {
          timeout = setTimeout(
            () => rejectPromise(new Error('concurrent lock stress timed out')),
            5_000,
          )
        }),
      ])
      expect(ownerCount).toBe(1)
    } finally {
      if (timeout) clearTimeout(timeout)
      releaseOwner()
    }
    const results = await allResults
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(
      results.filter(
        (result) =>
          result.status === 'rejected' &&
          result.reason instanceof Error &&
          result.reason.message.includes('already locked'),
      ),
    ).toHaveLength(31)
  })

  it('rejects extra artifacts and stale plan, dataset, profile, model, binary, runtime, or request identity', async () => {
    const mutationCases: Array<{ name: string; mutate: (root: string) => Promise<void> }> = [
      {
        name: 'extra run',
        mutate: async (root) => await writeFile(join(root, 'run-4.private.json'), '{}\n'),
      },
      {
        name: 'dataset',
        mutate: async (root) => {
          const path = join(root, 'run-1.private.json')
          const value = JSON.parse(await readFile(path, 'utf8'))
          value.dataset_class = 'private_representative'
          await writeCanonical(path, value)
        },
      },
      {
        name: 'model',
        mutate: async (root) => {
          const path = join(root, 'run-1.private.json')
          const value = JSON.parse(await readFile(path, 'utf8'))
          value.evaluation_run.model.model_id = 'tampered-model'
          await writeCanonical(path, value)
        },
      },
      {
        name: 'request',
        mutate: async (root) => {
          const path = join(root, 'run-1.private.json')
          const value = JSON.parse(await readFile(path, 'utf8'))
          value.request_sha256 = 'a'.repeat(64)
          await writeCanonical(path, value)
        },
      },
      {
        name: 'experiment plan',
        mutate: async (root) => {
          const path = join(root, 'experiment-plan.json')
          const value = JSON.parse(await readFile(path, 'utf8'))
          value.experiment_id = 'tampered-experiment'
          await writeCanonical(path, value)
        },
      },
      {
        name: 'source plan',
        mutate: async (root) => {
          const path = join(root, 'experiment-plan.json')
          const value = JSON.parse(await readFile(path, 'utf8'))
          value.source_sha256 = 'a'.repeat(64)
          await writeCanonical(path, value)
        },
      },
      {
        name: 'annotations plan',
        mutate: async (root) => {
          const path = join(root, 'experiment-plan.json')
          const value = JSON.parse(await readFile(path, 'utf8'))
          value.annotations_sha256 = 'a'.repeat(64)
          await writeCanonical(path, value)
        },
      },
      {
        name: 'annotations run',
        mutate: async (root) => {
          const path = join(root, 'run-1.private.json')
          const value = JSON.parse(await readFile(path, 'utf8'))
          value.annotations_sha256 = 'a'.repeat(64)
          await writeCanonical(path, value)
        },
      },
      {
        name: 'corpus plan',
        mutate: async (root) => {
          const path = join(root, 'experiment-plan.json')
          const value = JSON.parse(await readFile(path, 'utf8'))
          value.corpus_sha256 = 'a'.repeat(64)
          await writeCanonical(path, value)
        },
      },
      {
        name: 'host manifest run',
        mutate: async (root) => {
          const path = join(root, 'run-1.private.json')
          const value = JSON.parse(await readFile(path, 'utf8'))
          value.host_manifest_sha256 = 'a'.repeat(64)
          await writeCanonical(path, value)
        },
      },
      {
        name: 'binary plan',
        mutate: async (root) => {
          const path = join(root, 'experiment-plan.json')
          const value = JSON.parse(await readFile(path, 'utf8'))
          value.runtime_binary_sha256 = 'a'.repeat(64)
          await writeCanonical(path, value)
        },
      },
      {
        name: 'runtime config plan',
        mutate: async (root) => {
          const path = join(root, 'experiment-plan.json')
          const value = JSON.parse(await readFile(path, 'utf8'))
          value.runtime_configuration_sha256 = 'a'.repeat(64)
          await writeCanonical(path, value)
        },
      },
      {
        name: 'profile plan',
        mutate: async (root) => {
          const path = join(root, 'experiment-plan.json')
          const value = JSON.parse(await readFile(path, 'utf8'))
          value.profile_id = 'tampered-profile'
          await writeCanonical(path, value)
        },
      },
    ]
    for (const [index, mutation] of mutationCases.entries()) {
      const { inputs: validated } = await temporaryInput()
      const gateway = new PassingGateway(validated.corpus, validated.annotations)
      const options = optionsFor(validated, gateway, `identity-${index}`)
      const result = await runExactlyThree(options)
      await mutation.mutate(result.experimentRoot)
      await expect(runExactlyThree(options), mutation.name).rejects.toThrow()
    }
  })

  it('rejects gold-annotation substitution when resuming an immutable experiment', async () => {
    const { inputs: validated } = await temporaryInput()
    const gateway = new PassingGateway(validated.corpus, validated.annotations)
    const options = optionsFor(validated, gateway, 'annotation-substitution')
    await runExactlyThree(options)
    const substitutedAnnotations = {
      ...validated.annotations,
      annotation_version: 'substituted-gold@2',
    }
    const substitutedInputs: ValidatedInputs = {
      ...validated,
      annotations: substitutedAnnotations,
      annotationsSha256: canonicalSha256(substitutedAnnotations as unknown as JsonValue),
    }
    await expect(
      runExactlyThree(optionsFor(substitutedInputs, gateway, 'annotation-substitution')),
    ).rejects.toThrow('plan is stale')
  })

  it('rehashes and reparses exact raw bytes and binds each manifest hash into the report', async () => {
    const { inputs: validated } = await temporaryInput()
    const gateway = new PassingGateway(validated.corpus, validated.annotations)
    const options = optionsFor(validated, gateway, 'raw-binding')
    const result = await runExactlyThree(options)
    const runPath = join(result.experimentRoot, 'run-1.private.json')
    const run = JSON.parse(await readFile(runPath, 'utf8'))
    run.raw_response = '{"choices":[]}'
    run.raw_response_sha256 = sha256(run.raw_response)
    run.raw_response_json_valid = true
    await writeCanonical(runPath, run)
    await expect(runExactlyThree(options)).rejects.toThrow('provider-output validity')

    const second = await temporaryInput()
    const secondGateway = new PassingGateway(second.inputs.corpus, second.inputs.annotations)
    const secondOptions = optionsFor(second.inputs, secondGateway, 'manifest-binding')
    const secondResult = await runExactlyThree(secondOptions)
    const secondRunPath = join(secondResult.experimentRoot, 'run-1.private.json')
    const secondRun = JSON.parse(await readFile(secondRunPath, 'utf8'))
    const raw = JSON.parse(secondRun.raw_response)
    raw.timings.prompt_n += 1
    secondRun.raw_response = JSON.stringify(raw)
    secondRun.raw_response_sha256 = sha256(secondRun.raw_response)
    secondRun.performance.prompt_tokens += 1
    await writeCanonical(secondRunPath, secondRun)
    await expect(runExactlyThree(secondOptions)).rejects.toThrow('report differs')
  })

  it('never labels a failed operational run set as smoke complete', () => {
    expect(syntheticOperationalStatus(false)).toContain('FAILED')
    expect(syntheticOperationalStatus(false)).not.toContain('COMPLETE')
    expect(syntheticOperationalStatus(true)).toContain('COMPLETE')
  })

  it('never accepts a refusal surrogate as an operationally successful run', async () => {
    const { inputs: validated } = await temporaryInput()
    const gateway = new PassingGateway(validated.corpus, validated.annotations, (completion) => ({
      ...completion,
      response: null,
      failure: 'transport',
    }))
    const result = await runExactlyThree(optionsFor(validated, gateway, 'surrogate'))
    const manifests = await Promise.all(
      [1, 2, 3].map(async (index) =>
        JSON.parse(
          await readFile(join(result.experimentRoot, `run-${index}.private.json`), 'utf8'),
        ),
      ),
    )
    expect(operationalRunSetPassed(manifests)).toBe(false)
    expect(
      manifests.every(
        (manifest) =>
          manifest.result_state === 'request_failed' &&
          manifest.failure_code === 'transport' &&
          !manifest.provider_output_valid,
      ),
    ).toBe(true)
  })
})
