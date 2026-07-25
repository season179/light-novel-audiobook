import { randomBytes } from 'node:crypto'
import { link, lstat, mkdir, open, readdir, readFile, readlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  canonicalJson,
  canonicalSha256,
  type EvaluationRun,
  type JsonValue,
  RepresentativeCorpusScorer,
  sha256,
} from '@light-novel-audiobook/scoring-harness'
import type { GatewayCompletion, ModelGateway } from './gateway.js'
import type { BenchmarkProfile } from './profiles.js'
import { OUTPUT_SCHEMA_VERSION, PROMPT_VERSION, prepareRequest, SYSTEM_PROMPT } from './prompt.js'
import { type PinnedRuntimeContext, readChildExitEvidence } from './runtime.js'
import {
  type BenchmarkRunManifest,
  benchmarkRunManifestSchema,
  type ChildExitEvidence,
  type ExperimentPlan,
  experimentPlanSchema,
  type ModelOutput,
  modelOutputSchema,
  type Performance,
  type ResourceCapture,
} from './schemas.js'
import type { ValidatedInputs } from './workspace.js'

const RUN_COUNT = 3
const PLAN_NAME = 'experiment-plan.json'
const REPORT_NAME = 'sanitized-report.json'
const LOCK_NAME = '.experiment.lock'
const RUN_NAMES = ['run-1.private.json', 'run-2.private.json', 'run-3.private.json'] as const
const ALLOWED_ARTIFACTS = new Set([PLAN_NAME, REPORT_NAME, LOCK_NAME, ...RUN_NAMES])
const EMPTY_PERFORMANCE: Performance = {
  prompt_tokens: null,
  generated_tokens: null,
  prompt_tokens_per_second: null,
  generated_tokens_per_second: null,
}

async function requirePrivateDirectory(path: string): Promise<void> {
  const details = await lstat(path)
  if (!details.isDirectory() || details.isSymbolicLink() || (details.mode & 0o077) !== 0) {
    throw new Error('Experiment output directory is not private and symlink-free')
  }
}

async function createExperimentRoot(workspaceRoot: string, experimentId: string): Promise<string> {
  const experimentsRoot = join(workspaceRoot, 'experiments')
  try {
    await mkdir(experimentsRoot, { mode: 0o700 })
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  await requirePrivateDirectory(experimentsRoot)
  const experimentRoot = join(experimentsRoot, experimentId)
  try {
    await mkdir(experimentRoot, { mode: 0o700 })
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  await requirePrivateDirectory(experimentRoot)
  return experimentRoot
}

async function writeImmutableJson(path: string, value: JsonValue): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${canonicalJson(value)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await link(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function readCanonicalJson(path: string): Promise<{ value: unknown; bytes: string }> {
  const bytes = await readFile(path, 'utf8')
  const value = JSON.parse(bytes) as unknown
  if (`${canonicalJson(value as JsonValue)}\n` !== bytes) {
    throw new Error('Immutable experiment artifact is not canonical JSON')
  }
  return { value, bytes }
}

async function assertExactArtifacts(experimentRoot: string): Promise<Set<string>> {
  const entries = await readdir(experimentRoot, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !ALLOWED_ARTIFACTS.has(entry.name)) {
      throw new Error('Experiment contains an unexpected, non-file, or symlink artifact')
    }
  }
  return new Set(entries.map((entry) => entry.name))
}

interface ExperimentLockOwner {
  readonly schema_version: 'benchmark-experiment-lock@1'
  readonly pid: number
  readonly linux_start_time_ticks: string
  readonly executable: string
  readonly owner_token: string
}

async function linuxProcessIdentity(
  pid: number,
): Promise<{ startTimeTicks: string; executable: string } | null> {
  try {
    const statBytes = await readFile(`/proc/${pid}/stat`, 'utf8')
    const commandEnd = statBytes.lastIndexOf(')')
    if (commandEnd === -1) throw new Error('Linux process stat is malformed')
    const fieldsAfterCommand = statBytes
      .slice(commandEnd + 1)
      .trim()
      .split(/\s+/)
    const startTimeTicks = fieldsAfterCommand[19]
    if (!startTimeTicks || !/^\d+$/.test(startTimeTicks)) {
      throw new Error('Linux process start time is unavailable')
    }
    return { startTimeTicks, executable: await readlink(`/proc/${pid}/exe`) }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function parseLockOwner(value: unknown): ExperimentLockOwner {
  const owner = value as Partial<ExperimentLockOwner>
  if (
    typeof owner !== 'object' ||
    owner === null ||
    owner.schema_version !== 'benchmark-experiment-lock@1' ||
    !Number.isSafeInteger(owner.pid) ||
    (owner.pid ?? 0) <= 0 ||
    typeof owner.linux_start_time_ticks !== 'string' ||
    !/^\d+$/.test(owner.linux_start_time_ticks) ||
    typeof owner.executable !== 'string' ||
    owner.executable.length === 0 ||
    typeof owner.owner_token !== 'string' ||
    !/^[a-f0-9]{64}$/.test(owner.owner_token) ||
    Object.keys(owner).sort().join(',') !==
      'executable,linux_start_time_ticks,owner_token,pid,schema_version'
  ) {
    throw new Error('Experiment lock owner identity is invalid')
  }
  return owner as ExperimentLockOwner
}

async function readLockOwner(
  lockPath: string,
): Promise<{ owner: ExperimentLockOwner; bytes: string }> {
  const details = await lstat(lockPath)
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error('Experiment lock is not a regular file')
  }
  const bytes = await readFile(lockPath, 'utf8')
  const owner = parseLockOwner(JSON.parse(bytes) as unknown)
  if (`${canonicalJson(owner as unknown as JsonValue)}\n` !== bytes) {
    throw new Error('Experiment lock owner identity is not canonical')
  }
  return { owner, bytes }
}

async function lockOwnerIsLive(owner: ExperimentLockOwner): Promise<boolean> {
  const identity = await linuxProcessIdentity(owner.pid)
  return (
    identity !== null &&
    identity.startTimeTicks === owner.linux_start_time_ticks &&
    identity.executable === owner.executable
  )
}

async function releaseExperimentLock(lockPath: string, ownerToken: string): Promise<void> {
  const current = await readLockOwner(lockPath)
  if (current.owner.owner_token !== ownerToken) {
    throw new Error('Experiment lock ownership changed unexpectedly')
  }
  await rm(lockPath)
}

async function withExperimentLock<T>(experimentRoot: string, run: () => Promise<T>): Promise<T> {
  const identity = await linuxProcessIdentity(process.pid)
  if (!identity) throw new Error('Current Linux process identity is unavailable')
  const owner: ExperimentLockOwner = {
    schema_version: 'benchmark-experiment-lock@1',
    pid: process.pid,
    linux_start_time_ticks: identity.startTimeTicks,
    executable: identity.executable,
    owner_token: randomBytes(32).toString('hex'),
  }
  const lockPath = join(experimentRoot, LOCK_NAME)
  const candidatePath = join(
    experimentRoot,
    '..',
    `.experiment-lock-candidate-${process.pid}-${owner.owner_token}`,
  )
  const candidate = await open(candidatePath, 'wx', 0o600)
  try {
    await candidate.writeFile(`${canonicalJson(owner as unknown as JsonValue)}\n`)
    await candidate.sync()
  } finally {
    await candidate.close()
  }

  let acquired = false
  try {
    while (!acquired) {
      try {
        await link(candidatePath, lockPath)
        acquired = true
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const observed = await readLockOwner(lockPath)
        if (await lockOwnerIsLive(observed.owner)) {
          throw new Error('Experiment is already locked by another process')
        }
        const current = await readLockOwner(lockPath)
        if (current.bytes !== observed.bytes) continue
        await rm(lockPath)
      }
    }
  } finally {
    await rm(candidatePath, { force: true })
  }

  try {
    return await run()
  } finally {
    await releaseExperimentLock(lockPath, owner.owner_token)
  }
}

function scalarSlice(text: string, start: number, end: number): string {
  return Array.from(text).slice(start, end).join('')
}

function allRefusals(inputs: ValidatedInputs): ModelOutput {
  return {
    results: inputs.corpus.cases.map((item) => ({
      case_id: item.case_id,
      status: 'refused' as const,
      refusal_code: 'other' as const,
      review_required: true as const,
    })),
  }
}

function validateModelSemantics(output: ModelOutput, inputs: ValidatedInputs): void {
  if (
    output.results.length !== inputs.corpus.cases.length ||
    output.results.some((result, index) => result.case_id !== inputs.corpus.cases[index]?.case_id)
  ) {
    throw new Error('Model output case identity/order failed')
  }
  const allowedSpeakers = new Set([
    ...inputs.context.characters.map((character) => character.character_id),
    inputs.context.narrator_id,
    inputs.context.fallback_dialogue_id,
  ])
  for (const result of output.results) {
    if (result.status === 'predicted' && !allowedSpeakers.has(result.speaker)) {
      throw new Error('Model output used an unknown speaker')
    }
  }
}

function predictions(output: ModelOutput, inputs: ValidatedInputs): EvaluationRun['predictions'] {
  const passageByReference = new Map(
    inputs.source.passages.map((passage) => [passage.source_ref, passage]),
  )
  return output.results.map((result, index) => {
    const item = inputs.corpus.cases[index]
    if (!item) throw new Error('Missing corpus case')
    if (result.status === 'refused') {
      return {
        source_ref: item.source_ref,
        source_start: item.source_start,
        source_end: item.source_end,
        status: 'refused',
        refusal_code: result.refusal_code,
        review_required: true,
      }
    }
    const passage = passageByReference.get(item.source_ref)
    if (!passage) throw new Error('Missing source passage')
    return {
      source_ref: item.source_ref,
      source_start: item.source_start,
      source_end: item.source_end,
      status: 'predicted',
      text: scalarSlice(passage.source_text, item.source_start, item.source_end),
      kind: result.kind,
      speaker: result.speaker,
      review_required: result.review_required,
    }
  })
}

function parseProviderResponse(json: unknown): { output: ModelOutput; performance: Performance } {
  const body = json as {
    choices?: Array<{ message?: { content?: unknown } }>
    timings?: Record<string, unknown>
  }
  const content = body.choices?.[0]?.message?.content
  if (typeof content !== 'string') throw new Error('Provider response has no text content')
  const output = modelOutputSchema.parse(JSON.parse(content) as unknown)
  const timing = body.timings ?? {}
  const integer = (value: unknown): number | null =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
  const rate = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
  return {
    output,
    performance: {
      prompt_tokens: integer(timing.prompt_n),
      generated_tokens: integer(timing.predicted_n),
      prompt_tokens_per_second: rate(timing.prompt_per_second),
      generated_tokens_per_second: rate(timing.predicted_per_second),
    },
  }
}

function evaluationRun(options: {
  runIndex: number
  inputs: ValidatedInputs
  profile: BenchmarkProfile
  runtime: PinnedRuntimeContext
  request: ReturnType<typeof prepareRequest>
  output: ModelOutput
  resources: ResourceCapture
  childExit: ChildExitEvidence
  outOfMemory: boolean
}): EvaluationRun {
  return {
    schema_version: 'evaluation-run@2',
    run_index: options.runIndex,
    source_sha256: options.inputs.sourceSha256,
    corpus_sha256: options.inputs.corpusSha256,
    model: {
      adapter_id: 'llama.cpp-openai-chat-completions',
      adapter_version: 'gemma-benchmark-adapter@2',
      model_id: options.profile.modelId,
      model_sha256: options.profile.modelSha256,
      prompt_version: PROMPT_VERSION,
      prompt_sha256: options.request.promptSha256,
      output_schema_version: OUTPUT_SCHEMA_VERSION,
      output_schema_sha256: options.request.outputSchemaSha256,
      seed: options.profile.seed,
      context_size: options.profile.contextSize,
      parameters: {
        temperature: options.profile.temperature,
        top_p: options.profile.topP,
        max_tokens: options.profile.maxTokens,
        gpu_layers: options.profile.gpuLayers,
        partial_gpu_offload: options.profile.gpuLayers !== 999,
        flash_attention: options.profile.flashAttention,
        cache_type_k: options.profile.cacheTypeK,
        cache_type_v: options.profile.cacheTypeV,
        batch_size: options.profile.batchSize,
        micro_batch_size: options.profile.microBatchSize,
        threads: options.profile.threads,
        reasoning: options.profile.reasoning,
        prompt_cache: false,
        llama_cpp_commit: options.runtime.host.llamaCommit,
        llama_cpp_binary_sha256: options.runtime.host.binarySha256,
        cuda_compiler: options.runtime.host.cudaCompiler,
        host_manifest_sha256: options.runtime.hostManifestSha256,
        runtime_configuration_sha256: options.runtime.runtimeConfigurationSha256,
      },
    },
    operational: {
      resource_measurement: {
        method_version: 'wsl-system-resource-sampling@2',
        collector_id: 'proc-meminfo-and-nvidia-smi-device-total',
        collector_version: '2.0.0',
        elapsed_scope: 'complete-direction-run',
        memory_unit: 'mebibyte',
      },
      elapsed_ms: options.resources.elapsed_ms,
      peak_vram_mib: options.resources.peak_vram_mib,
      peak_ram_mib: options.resources.peak_ram_mib,
      crashed: options.childExit.observed_exited,
      out_of_memory: options.outOfMemory,
    },
    predictions: predictions(options.output, options.inputs),
  }
}

function makePlan(options: {
  experimentId: string
  datasetClass: 'private_representative' | 'synthetic_operational'
  inputs: ValidatedInputs
  profile: BenchmarkProfile
  runtime: PinnedRuntimeContext
  request: ReturnType<typeof prepareRequest>
}): ExperimentPlan {
  return {
    schema_version: 'benchmark-experiment-plan@3',
    experiment_id: options.experimentId,
    dataset_class: options.datasetClass,
    profile_id: options.profile.id,
    profile_order: options.profile.order,
    run_count: 3,
    source_sha256: options.inputs.sourceSha256,
    corpus_sha256: options.inputs.corpusSha256,
    annotations_sha256: options.inputs.annotationsSha256,
    context_sha256: canonicalSha256(options.inputs.context as unknown as JsonValue),
    model_id: options.profile.modelId,
    model_sha256: options.profile.modelSha256,
    host_manifest_sha256: options.runtime.hostManifestSha256,
    runtime_binary_sha256: options.runtime.host.binarySha256,
    runtime_configuration_sha256: options.runtime.runtimeConfigurationSha256,
    request_sha256: options.request.requestSha256,
    prompt_sha256: options.request.promptSha256,
    output_schema_sha256: options.request.outputSchemaSha256,
  }
}

function fallbackResources(elapsedMs: number): ResourceCapture {
  return {
    method_version: 'wsl-system-resource-sampling@2',
    elapsed_ms: elapsedMs,
    peak_vram_mib: 0,
    peak_ram_mib: 0,
    sample_count: 0,
    initial_sample_captured: false,
    final_sample_captured: false,
    complete: false,
    error_code: 'collector_failed',
  }
}

function runSucceeded(manifest: BenchmarkRunManifest): boolean {
  return (
    manifest.result_state === 'completed' &&
    manifest.failure_code === 'none' &&
    manifest.provider_output_valid &&
    manifest.raw_response_json_valid &&
    manifest.provider_http_status !== null &&
    manifest.provider_http_status >= 200 &&
    manifest.provider_http_status < 300 &&
    manifest.resources.complete &&
    !manifest.child_exit.observed_exited &&
    !manifest.evaluation_run.operational.crashed &&
    !manifest.evaluation_run.operational.out_of_memory
  )
}

export function operationalRunSetPassed(manifests: readonly BenchmarkRunManifest[]): boolean {
  return (
    manifests.length === RUN_COUNT &&
    manifests.every((manifest, index) => manifest.run_index === index + 1 && runSucceeded(manifest))
  )
}

function compareCanonical(left: unknown, right: unknown, message: string): void {
  if (canonicalSha256(left as JsonValue) !== canonicalSha256(right as JsonValue)) {
    throw new Error(message)
  }
}

function validateResumedRun(options: {
  manifest: BenchmarkRunManifest
  rawFileBytes: string
  runIndex: number
  plan: ExperimentPlan
  planSha256: string
  inputs: ValidatedInputs
  profile: BenchmarkProfile
  runtime: PinnedRuntimeContext
  request: ReturnType<typeof prepareRequest>
}): void {
  const { manifest } = options
  if (
    manifest.experiment_id !== options.plan.experiment_id ||
    manifest.dataset_class !== options.plan.dataset_class ||
    manifest.run_index !== options.runIndex ||
    manifest.plan_sha256 !== options.planSha256 ||
    manifest.host_manifest_sha256 !== options.runtime.hostManifestSha256 ||
    manifest.runtime_configuration_sha256 !== options.runtime.runtimeConfigurationSha256 ||
    manifest.request_sha256 !== options.request.requestSha256 ||
    manifest.annotations_sha256 !== options.inputs.annotationsSha256 ||
    options.plan.annotations_sha256 !== options.inputs.annotationsSha256 ||
    manifest.evaluation_run.source_sha256 !== options.inputs.sourceSha256 ||
    manifest.evaluation_run.corpus_sha256 !== options.inputs.corpusSha256 ||
    manifest.evaluation_run.model.model_id !== options.profile.modelId ||
    manifest.evaluation_run.model.model_sha256 !== options.profile.modelSha256
  ) {
    throw new Error('Resumed run identity is stale or mismatched')
  }
  if (sha256(manifest.raw_response) !== manifest.raw_response_sha256) {
    throw new Error('Resumed raw response hash mismatch')
  }
  if (`${canonicalJson(manifest as unknown as JsonValue)}\n` !== options.rawFileBytes) {
    throw new Error('Resumed run bytes are not canonical')
  }
  let rawJson: unknown = null
  let rawJsonValid = false
  try {
    rawJson = JSON.parse(manifest.raw_response) as unknown
    rawJsonValid = true
  } catch {
    // Explicitly compared below.
  }
  if (rawJsonValid !== manifest.raw_response_json_valid) {
    throw new Error('Resumed raw response parse evidence mismatch')
  }

  let output = allRefusals(options.inputs)
  let parsedPerformance = EMPTY_PERFORMANCE
  let providerValid = false
  if (
    rawJsonValid &&
    manifest.provider_http_status !== null &&
    manifest.provider_http_status >= 200 &&
    manifest.provider_http_status < 300
  ) {
    try {
      const parsed = parseProviderResponse(rawJson)
      validateModelSemantics(parsed.output, options.inputs)
      output = parsed.output
      parsedPerformance = parsed.performance
      providerValid = true
    } catch {
      // A malformed/model-invalid run must retain its deterministic surrogate.
    }
  }
  if (providerValid !== manifest.provider_output_valid) {
    throw new Error('Resumed provider-output validity mismatch')
  }
  const expectedState = providerValid
    ? 'completed'
    : manifest.provider_http_status !== null &&
        manifest.provider_http_status >= 200 &&
        manifest.provider_http_status < 300
      ? 'model_output_invalid'
      : 'request_failed'
  let expectedFailure: BenchmarkRunManifest['failure_code']
  if (manifest.child_exit.observed_exited) expectedFailure = 'runtime_exit'
  else if (manifest.evaluation_run.operational.out_of_memory) expectedFailure = 'oom'
  else if (!manifest.resources.complete) expectedFailure = 'resource_capture'
  else if (providerValid) expectedFailure = 'none'
  else if (manifest.provider_http_status === null) {
    const transportCode =
      rawJsonValid &&
      typeof rawJson === 'object' &&
      rawJson !== null &&
      'error' in rawJson &&
      ((rawJson as { error?: unknown }).error === 'timeout' ||
        (rawJson as { error?: unknown }).error === 'transport')
        ? (rawJson as { error: 'timeout' | 'transport' }).error
        : 'transport'
    expectedFailure = transportCode
  } else if (manifest.provider_http_status >= 200 && manifest.provider_http_status < 300) {
    expectedFailure = rawJsonValid ? 'schema' : 'malformed_json'
  } else expectedFailure = 'http'
  if (manifest.result_state !== expectedState || manifest.failure_code !== expectedFailure) {
    throw new Error('Resumed result state or failure code mismatch')
  }
  compareCanonical(
    manifest.performance,
    providerValid ? parsedPerformance : EMPTY_PERFORMANCE,
    'Resumed performance evidence mismatch',
  )
  const expectedRun = evaluationRun({
    runIndex: options.runIndex,
    inputs: options.inputs,
    profile: options.profile,
    runtime: options.runtime,
    request: options.request,
    output,
    resources: manifest.resources,
    childExit: manifest.child_exit,
    outOfMemory: manifest.evaluation_run.operational.out_of_memory,
  })
  compareCanonical(manifest.evaluation_run, expectedRun, 'Resumed evaluation run mismatch')
  if (manifest.failure_code === 'none' && !runSucceeded(manifest)) {
    throw new Error('Resumed run falsely claims operational success')
  }
}

async function createRun(options: {
  runIndex: number
  plan: ExperimentPlan
  planSha256: string
  inputs: ValidatedInputs
  profile: BenchmarkProfile
  runtime: PinnedRuntimeContext
  request: ReturnType<typeof prepareRequest>
  gateway: ModelGateway
}): Promise<BenchmarkRunManifest> {
  const started = performance.now()
  let completion: GatewayCompletion
  try {
    completion = await options.gateway.complete(options.request.body)
  } catch {
    completion = {
      response: null,
      failure: 'transport',
      resources: fallbackResources(Math.ceil(performance.now() - started)),
    }
  }
  const childExit = readChildExitEvidence(options.runtime.child)
  const response = completion.response
  const rawResponse = response?.raw ?? canonicalJson({ error: completion.failure })
  const rawJsonValid = response?.jsonValid ?? true
  const outOfMemory = response ? /out of memory|cuda error/i.test(response.raw) : false
  let output = allRefusals(options.inputs)
  let performanceResult = EMPTY_PERFORMANCE
  let providerOutputValid = false
  let resultState: BenchmarkRunManifest['result_state'] = 'request_failed'
  let failureCode: BenchmarkRunManifest['failure_code'] =
    completion.failure === 'timeout'
      ? 'timeout'
      : completion.failure === 'transport'
        ? 'transport'
        : 'http'

  if (response?.ok && response.jsonValid) {
    try {
      const parsed = parseProviderResponse(response.json)
      validateModelSemantics(parsed.output, options.inputs)
      output = parsed.output
      performanceResult = parsed.performance
      providerOutputValid = true
      resultState = 'completed'
      failureCode = 'none'
    } catch {
      resultState = 'model_output_invalid'
      failureCode = 'schema'
    }
  } else if (response?.ok && !response.jsonValid) {
    resultState = 'model_output_invalid'
    failureCode = 'malformed_json'
  }
  if (outOfMemory) failureCode = 'oom'
  if (!completion.resources.complete) failureCode = 'resource_capture'
  if (childExit.observed_exited) failureCode = 'runtime_exit'

  const run = evaluationRun({
    runIndex: options.runIndex,
    inputs: options.inputs,
    profile: options.profile,
    runtime: options.runtime,
    request: options.request,
    output,
    resources: completion.resources,
    childExit,
    outOfMemory,
  })
  return benchmarkRunManifestSchema.parse({
    schema_version: 'benchmark-run-manifest@3',
    experiment_id: options.plan.experiment_id,
    dataset_class: options.plan.dataset_class,
    run_index: options.runIndex,
    plan_sha256: options.planSha256,
    host_manifest_sha256: options.runtime.hostManifestSha256,
    runtime_configuration_sha256: options.runtime.runtimeConfigurationSha256,
    request_sha256: options.request.requestSha256,
    annotations_sha256: options.inputs.annotationsSha256,
    raw_response_sha256: sha256(rawResponse),
    raw_response: rawResponse,
    raw_response_json_valid: rawJsonValid,
    provider_http_status: response?.status ?? null,
    provider_output_valid: providerOutputValid,
    result_state: resultState,
    failure_code: failureCode,
    performance: performanceResult,
    resources: completion.resources,
    child_exit: childExit,
    evaluation_run: run,
  })
}

export async function runExactlyThree(options: {
  experimentId: string
  datasetClass: 'private_representative' | 'synthetic_operational'
  inputs: ValidatedInputs
  profile: BenchmarkProfile
  runtime: PinnedRuntimeContext
  gateway: ModelGateway
}): Promise<{
  experimentRoot: string
  reportPath: string
  overallPassed: boolean
  operationalPassed: boolean
}> {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(options.experimentId)) {
    throw new Error('Experiment ID must be an opaque safe identifier')
  }
  const experimentRoot = await createExperimentRoot(
    options.inputs.workspaceRoot,
    options.experimentId,
  )
  return await withExperimentLock(experimentRoot, async () => {
    const artifacts = await assertExactArtifacts(experimentRoot)
    const request = prepareRequest(
      options.inputs.source,
      options.inputs.corpus,
      options.inputs.context,
      options.profile.id,
      {
        seed: options.profile.seed,
        temperature: options.profile.temperature,
        topP: options.profile.topP,
        maxTokens: options.profile.maxTokens,
      },
    )
    const expectedPlan = makePlan({ ...options, request })
    experimentPlanSchema.parse(expectedPlan)
    const planPath = join(experimentRoot, PLAN_NAME)
    let plan = expectedPlan
    if (artifacts.has(PLAN_NAME)) {
      const existing = await readCanonicalJson(planPath)
      plan = experimentPlanSchema.parse(existing.value)
      compareCanonical(plan, expectedPlan, 'Experiment plan is stale or mismatched')
    } else {
      await writeImmutableJson(planPath, expectedPlan as unknown as JsonValue)
    }
    const planSha256 = canonicalSha256(plan as unknown as JsonValue)

    const existingRunCount = RUN_NAMES.filter((name) => artifacts.has(name)).length
    if (artifacts.has(REPORT_NAME) && existingRunCount !== RUN_COUNT) {
      throw new Error('Sanitized report exists without exactly three run manifests')
    }

    const tokenMaterial = `${SYSTEM_PROMPT}\n${canonicalJson(request.body as unknown as JsonValue)}`
    const promptTokens = await options.gateway.countTokens(tokenMaterial)
    if (promptTokens + options.profile.maxTokens > options.profile.contextSize) {
      throw new Error('Prompt and reserved output exceed the pinned 32K context')
    }

    const manifests: BenchmarkRunManifest[] = []
    const manifestHashes: string[] = []
    for (let runIndex = 1; runIndex <= RUN_COUNT; runIndex += 1) {
      const runPath = join(experimentRoot, RUN_NAMES[runIndex - 1] as string)
      if (artifacts.has(RUN_NAMES[runIndex - 1] as string)) {
        const existing = await readCanonicalJson(runPath)
        const manifest = benchmarkRunManifestSchema.parse(existing.value)
        validateResumedRun({
          manifest,
          rawFileBytes: existing.bytes,
          runIndex,
          plan,
          planSha256,
          inputs: options.inputs,
          profile: options.profile,
          runtime: options.runtime,
          request,
        })
        manifests.push(manifest)
        manifestHashes.push(sha256(existing.bytes))
        continue
      }

      const manifest = await createRun({
        runIndex,
        plan,
        planSha256,
        inputs: options.inputs,
        profile: options.profile,
        runtime: options.runtime,
        request,
        gateway: options.gateway,
      })
      await writeImmutableJson(runPath, manifest as unknown as JsonValue)
      const bytes = await readFile(runPath, 'utf8')
      manifests.push(manifest)
      manifestHashes.push(sha256(bytes))
    }

    if (manifests.length !== RUN_COUNT) throw new Error('Exactly three immutable runs are required')
    const operationalPassed = operationalRunSetPassed(manifests)
    const scoring = new RepresentativeCorpusScorer().score({
      source: options.inputs.source,
      corpus: options.inputs.corpus,
      annotations: options.inputs.annotations,
      runs: manifests.map((manifest) => manifest.evaluation_run),
    })
    const report = {
      schema_version: 'issue-6-benchmark-report@3',
      dataset_class: options.datasetClass,
      representative_accuracy_claim_permitted: options.datasetClass === 'private_representative',
      profile_id: options.profile.id,
      profile_order: options.profile.order,
      plan_sha256: planSha256,
      annotations_sha256: options.inputs.annotationsSha256,
      run_count: RUN_COUNT,
      run_manifest_sha256: manifestHashes,
      operational_passed: operationalPassed,
      scoring,
      runs: manifests.map((manifest) => ({
        run_index: manifest.run_index,
        result_state: manifest.result_state,
        failure_code: manifest.failure_code,
        provider_output_valid: manifest.provider_output_valid,
        resources: manifest.resources,
        child_exit: manifest.child_exit,
        ...manifest.performance,
      })),
      decision:
        options.datasetClass === 'synthetic_operational'
          ? operationalPassed
            ? 'synthetic-operational-smoke-only'
            : 'synthetic-operational-smoke-failed'
          : operationalPassed && scoring.overall_passed
            ? 'selected-profile'
            : 'acceptance-failed-follow-locked-fallback-order',
    } as const
    const reportPath = join(experimentRoot, REPORT_NAME)
    if (artifacts.has(REPORT_NAME)) {
      const existing = await readCanonicalJson(reportPath)
      compareCanonical(
        existing.value,
        report,
        'Existing immutable report differs from recomputation',
      )
    } else {
      await writeImmutableJson(reportPath, report as unknown as JsonValue)
    }
    const finalArtifacts = await assertExactArtifacts(experimentRoot)
    if (
      !finalArtifacts.has(PLAN_NAME) ||
      !finalArtifacts.has(REPORT_NAME) ||
      RUN_NAMES.some((name) => !finalArtifacts.has(name))
    ) {
      throw new Error('Experiment is not the exact plan/report/three-run artifact set')
    }
    return {
      experimentRoot,
      reportPath,
      overallPassed: operationalPassed && scoring.overall_passed,
      operationalPassed,
    }
  })
}
