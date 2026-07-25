import type { ChildProcess } from 'node:child_process'
import { link, lstat, mkdir, open, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  canonicalJson,
  canonicalSha256,
  type EvaluationRun,
  RepresentativeCorpusScorer,
  sha256,
} from '@light-novel-audiobook/scoring-harness'
import type { ModelGateway } from './gateway.js'
import type { BenchmarkProfile } from './profiles.js'
import { OUTPUT_SCHEMA_VERSION, PROMPT_VERSION, prepareRequest, SYSTEM_PROMPT } from './prompt.js'
import type { HostManifest } from './runtime.js'
import {
  type BenchmarkRunManifest,
  benchmarkRunManifestSchema,
  type ModelOutput,
  modelOutputSchema,
} from './schemas.js'
import type { ValidatedInputs } from './workspace.js'

const RUN_COUNT = 3

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

async function writeImmutableJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${canonicalJson(value as never)}\n`)
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

function parseProviderResponse(json: unknown): {
  output: ModelOutput
  performance: BenchmarkRunManifest['performance']
} {
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
  host: HostManifest
  request: ReturnType<typeof prepareRequest>
  output: ModelOutput
  elapsedMs: number
  peakVramMib: number
  peakRamMib: number
  crashed: boolean
  outOfMemory: boolean
}): EvaluationRun {
  return {
    schema_version: 'evaluation-run@2',
    run_index: options.runIndex,
    source_sha256: options.inputs.sourceSha256,
    corpus_sha256: options.inputs.corpusSha256,
    model: {
      adapter_id: 'llama.cpp-openai-chat-completions',
      adapter_version: 'gemma-benchmark-adapter@1',
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
        llama_cpp_commit: options.host.llamaCommit,
        llama_cpp_binary_sha256: options.host.binarySha256,
        cuda_compiler: options.host.cudaCompiler,
      },
    },
    operational: {
      resource_measurement: {
        method_version: 'wsl-system-resource-sampling@1',
        collector_id: 'proc-meminfo-and-nvidia-smi-device-total',
        collector_version: '1.0.0',
        elapsed_scope: 'complete-direction-run',
        memory_unit: 'mebibyte',
      },
      elapsed_ms: options.elapsedMs,
      peak_vram_mib: options.peakVramMib,
      peak_ram_mib: options.peakRamMib,
      crashed: options.crashed,
      out_of_memory: options.outOfMemory,
    },
    predictions: predictions(options.output, options.inputs),
  }
}

export async function runExactlyThree(options: {
  experimentId: string
  datasetClass: 'private_representative' | 'synthetic_operational'
  inputs: ValidatedInputs
  profile: BenchmarkProfile
  host: HostManifest
  gateway: ModelGateway
  child: ChildProcess
}): Promise<{ reportPath: string; overallPassed: boolean; operationalPassed: boolean }> {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(options.experimentId)) {
    throw new Error('Experiment ID must be an opaque safe identifier')
  }
  const experimentRoot = await createExperimentRoot(
    options.inputs.workspaceRoot,
    options.experimentId,
  )
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
  const plan = {
    schema_version: 'benchmark-experiment-plan@1',
    experiment_id: options.experimentId,
    dataset_class: options.datasetClass,
    profile_id: options.profile.id,
    run_count: RUN_COUNT,
    source_sha256: options.inputs.sourceSha256,
    corpus_sha256: options.inputs.corpusSha256,
    context_sha256: canonicalSha256(options.inputs.context),
    request_sha256: request.requestSha256,
    runtime_binary_sha256: options.host.binarySha256,
  }
  const planPath = join(experimentRoot, 'experiment-plan.json')
  try {
    await writeImmutableJson(planPath, plan)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = JSON.parse(await readFile(planPath, 'utf8')) as unknown
    if (canonicalSha256(existing as never) !== canonicalSha256(plan as never)) {
      throw new Error('Experiment ID already has a different immutable plan')
    }
  }

  const tokenMaterial = `${SYSTEM_PROMPT}\n${canonicalJson(request.body as never)}`
  const promptTokens = await options.gateway.countTokens(tokenMaterial)
  if (promptTokens + options.profile.maxTokens > options.profile.contextSize) {
    throw new Error('Prompt and reserved output exceed the pinned 32K context')
  }

  const manifests: BenchmarkRunManifest[] = []
  for (let runIndex = 1; runIndex <= RUN_COUNT; runIndex += 1) {
    const runPath = join(experimentRoot, `run-${runIndex}.private.json`)
    try {
      const existing = benchmarkRunManifestSchema.parse(JSON.parse(await readFile(runPath, 'utf8')))
      if (existing.request_sha256 !== request.requestSha256 || existing.run_index !== runIndex) {
        throw new Error('Existing immutable run does not match this experiment')
      }
      manifests.push(existing)
      continue
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    let output = allRefusals(options.inputs)
    let rawResponse = canonicalJson({ error: 'request_failed' })
    let resultState: BenchmarkRunManifest['result_state'] = 'request_failed'
    let failureCode: BenchmarkRunManifest['failure_code'] = 'http'
    let performanceResult: BenchmarkRunManifest['performance'] = {
      prompt_tokens: null,
      generated_tokens: null,
      prompt_tokens_per_second: null,
      generated_tokens_per_second: null,
    }
    let elapsedMs = 0
    let peakVramMib = 0
    let peakRamMib = 0
    let outOfMemory = false
    const started = performance.now()
    try {
      const response = await options.gateway.complete(request.body)
      rawResponse = response.raw
      elapsedMs = response.resources.elapsedMs
      peakVramMib = response.resources.peakVramMib
      peakRamMib = response.resources.peakRamMib
      outOfMemory = /out of memory|cuda error/i.test(response.raw)
      if (!response.ok) {
        failureCode = outOfMemory ? 'oom' : 'http'
      } else {
        try {
          const parsed = parseProviderResponse(response.json)
          validateModelSemantics(parsed.output, options.inputs)
          output = parsed.output
          performanceResult = parsed.performance
          resultState = 'completed'
          failureCode = 'none'
        } catch {
          resultState = 'model_output_invalid'
          failureCode = 'schema'
        }
      }
    } catch {
      elapsedMs = Math.ceil(performance.now() - started)
      failureCode =
        options.child.exitCode !== null || options.child.signalCode !== null
          ? 'runtime_exit'
          : 'http'
    }
    const crashed = options.child.exitCode !== null || options.child.signalCode !== null
    const run = evaluationRun({
      runIndex,
      inputs: options.inputs,
      profile: options.profile,
      host: options.host,
      request,
      output,
      elapsedMs,
      peakVramMib,
      peakRamMib,
      crashed,
      outOfMemory,
    })
    const manifest: BenchmarkRunManifest = {
      schema_version: 'benchmark-run-manifest@1',
      experiment_id: options.experimentId,
      dataset_class: options.datasetClass,
      run_index: runIndex,
      request_sha256: request.requestSha256,
      raw_response_sha256: sha256(rawResponse),
      raw_response: rawResponse,
      result_state: resultState,
      failure_code: failureCode,
      performance: performanceResult,
      evaluation_run: run,
    }
    benchmarkRunManifestSchema.parse(manifest)
    await writeImmutableJson(runPath, manifest)
    manifests.push(manifest)
  }

  if (manifests.length !== RUN_COUNT) throw new Error('Exactly three immutable runs are required')
  const scoring = new RepresentativeCorpusScorer().score({
    source: options.inputs.source,
    corpus: options.inputs.corpus,
    annotations: options.inputs.annotations,
    runs: manifests.map((manifest) => manifest.evaluation_run),
  })
  const report = {
    schema_version: 'issue-6-benchmark-report@1',
    dataset_class: options.datasetClass,
    representative_accuracy_claim_permitted: options.datasetClass === 'private_representative',
    profile_id: options.profile.id,
    profile_order: options.profile.order,
    run_count: RUN_COUNT,
    scoring,
    performance: manifests.map((manifest) => ({
      run_index: manifest.run_index,
      result_state: manifest.result_state,
      ...manifest.performance,
    })),
    decision:
      options.datasetClass === 'synthetic_operational'
        ? 'synthetic-operational-smoke-only'
        : scoring.overall_passed
          ? 'selected-profile'
          : 'acceptance-failed-follow-locked-fallback-order',
  }
  const reportPath = join(experimentRoot, 'sanitized-report.json')
  try {
    await writeImmutableJson(reportPath, report)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = JSON.parse(await readFile(reportPath, 'utf8')) as unknown
    if (canonicalSha256(existing as never) !== canonicalSha256(report as never)) {
      throw new Error('Existing immutable report differs from recomputed scoring')
    }
  }
  const operationalMetricNames = [
    'run_set_integrity',
    'schema_validity',
    'source_corpus_identity',
    'prediction_order_integrity',
    'elapsed_time_within_limit',
    'vram_within_limit',
    'ram_within_limit',
    'operational_success',
    'context_size_configuration',
    'repeated_run_configuration',
  ] as const
  return {
    reportPath,
    overallPassed: scoring.overall_passed,
    operationalPassed: operationalMetricNames.every((name) => scoring.metrics[name].passed),
  }
}
