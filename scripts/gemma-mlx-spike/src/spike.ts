import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { canonicalSha256 } from '../../../packages/gemma-director/src/canonical-json.js'
import { DirectorError } from '../../../packages/gemma-director/src/errors.js'
import { DirectorFidelityError } from '../../../packages/gemma-director/src/validation.js'
import { parseArgs, SPIKE_HOST, SPIKE_PORT, type SpikeConfig } from './args.js'
import {
  collectHostMemoryFacts,
  metric,
  portIsFree,
  RssSampler,
  type Metric,
} from './collectors.js'
import { prepareOutDir, writeEvidence, type SpikeEvidence } from './evidence.js'
import {
  loadRequest,
  PROMPT_VERSION,
  requestPayload,
  runDirection,
  SAMPLING,
  SCHEMA_VERSION,
  SPIKE_WIRE_MODEL_ID,
  SYSTEM_PROMPT,
  type DirectionRunResult,
} from './request.js'
import { mlxRuntimeIdentity, serverBinFacts } from './runtime-identity.js'
import { OwnedMlxServer, serverLogPath } from './server.js'
import { resolveSnapshotPath, verifySnapshot } from './snapshot.js'

const execFile = promisify(execFileCallback)
const DRIVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(DRIVER_ROOT, '..', '..')

/** mlx_lm.server 0.31.3 flags actually used by this driver, recorded by exact name. */
function serverArgs(snapshotPath: string): readonly string[] {
  return [
    '--model',
    snapshotPath,
    '--host',
    SPIKE_HOST,
    '--port',
    String(SPIKE_PORT),
    '--log-level',
    'INFO',
  ]
}

async function installedPackageVersion(name: string): Promise<string | null> {
  try {
    const manifest = JSON.parse(
      await readFile(resolve(DRIVER_ROOT, 'node_modules', name, 'package.json'), 'utf8'),
    ) as { version?: string }
    return manifest.version ?? null
  } catch {
    return null
  }
}

async function gitCommit(): Promise<string | null> {
  try {
    const { stdout } = await execFile('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'])
    return stdout.trim()
  } catch {
    return null
  }
}

async function hostIdentity(): Promise<Record<string, unknown>> {
  const sysctl = async (key: string): Promise<string | null> => {
    try {
      const { stdout } = await execFile('sysctl', ['-n', key])
      return stdout.trim()
    } catch {
      return null
    }
  }
  const swVers = async (): Promise<string | null> => {
    try {
      const { stdout } = await execFile('sw_vers', ['-productVersion'])
      return stdout.trim()
    } catch {
      return null
    }
  }
  return {
    platform: process.platform,
    arch: process.arch,
    cpuBrand: await sysctl('machdep.cpu.brand_string'),
    osVersion: await swVers(),
    nodeVersion: process.version,
  }
}

interface RunSection {
  readonly name: string
  readonly result: DirectionRunResult
}

function runMetrics(run: RunSection): Record<string, Metric> {
  const { result } = run
  const firstTokenMs = result.dispatchToFirstTokenMs
  const generationMs =
    firstTokenMs === null ? null : result.dispatchToCompleteMs - firstTokenMs
  return {
    end_to_end_elapsed: metric(
      result.dispatchToCompleteMs,
      'performance.now() around chat() stream consumption',
      'ms',
    ),
    dispatch_to_first_token: metric(
      firstTokenMs,
      'performance.now() at first TEXT_MESSAGE_CONTENT event',
      'ms',
    ),
    prompt_tokens: metric(
      result.usage?.promptTokens ?? null,
      'SSE final usage chunk (stream_options.include_usage) from mlx_lm.server',
      'tokens',
    ),
    cached_prompt_tokens: metric(
      result.usage?.cachedPromptTokens ?? null,
      'SSE usage.prompt_tokens_details.cached_tokens from mlx_lm.server',
      'tokens',
    ),
    completion_tokens: metric(
      result.usage?.completionTokens ?? null,
      'SSE final usage chunk (stream_options.include_usage) from mlx_lm.server',
      'tokens',
    ),
    prompt_throughput: metric(
      result.usage !== null && firstTokenMs !== null && firstTokenMs > 0
        ? Math.round((result.usage.promptTokens / firstTokenMs) * 1_000_000) / 1_000
        : null,
      'derived: prompt_tokens / dispatch-to-first-token',
      'tokens/s',
      run.name === 'cold'
        ? 'cold run conflates lazy model load with prefill; use the warm run for prompt throughput'
        : undefined,
    ),
    generation_throughput: metric(
      result.usage !== null && generationMs !== null && generationMs > 0
        ? Math.round((result.usage.completionTokens / generationMs) * 1_000_000) / 1_000
        : null,
      'derived: completion_tokens / (first-token to stream-complete)',
      'tokens/s',
    ),
  }
}

function gateSection(runs: readonly RunSection[]): Record<string, unknown> {
  return {
    structured_output_parse: {
      passed: runs.every((run) => run.result.output !== undefined),
      collector: '@tanstack/ai structured-output stream (CUSTOM structured-output.complete)',
    },
    schema_validation: {
      passed: true, // reaching this section means directionWireOutputSchemaFor().parse() passed
      collector: 'TanStack AI client-side schema validation + outputSchema.parse',
    },
    fidelity_validation: {
      passed: true, // reaching this section means validateDirectionOutput did not throw
      collector: 'deterministic validateDirectionOutput (packages/gemma-director/src/validation.ts)',
    },
    server_enforced_json_schema: {
      value: false,
      basis:
        'mlx_lm.server 0.31.3 accepts but silently ignores response_format/json_schema ' +
        '(verified statically: no response_format or json_schema handling in server.py). ' +
        'The strict response_format is transmitted and preserved in evidence; validity rests ' +
        'entirely on the client-side gates above. No server-side schema parity is claimed.',
    },
  }
}

function runSection(run: RunSection): Record<string, unknown> {
  const { result } = run
  return {
    metrics: runMetrics(run),
    response_status: result.responseStatus,
    usage_from_run_finished_event: result.runFinishedUsage,
    transmitted: result.transmitted,
    hashes: {
      request_payload_sha256: result.requestPayloadSha256,
      raw_output_sha256: result.rawOutputSha256,
      validated_output_sha256: result.validatedOutputSha256,
      raw_response_body_sha256: result.rawResponseSha256,
    },
    mechanical_repairs: result.repairs,
    annotations: result.validated.annotations.length,
    warnings: result.validated.warnings.length,
    warning_codes: [...new Set(result.validated.warnings.map((warning) => warning.code))],
  }
}

function errorSection(error: unknown): Record<string, unknown> {
  if (error instanceof DirectorFidelityError) {
    return {
      name: error.name,
      code: error.code,
      message: error.message,
      fidelity_findings: error.findings,
    }
  }
  if (error instanceof DirectorError) {
    return { name: error.name, code: error.code, message: error.message, retryable: error.retryable }
  }
  if (error instanceof Error) return { name: error.name, message: error.message }
  return { name: 'unknown', message: String(error) }
}

async function main(): Promise<void> {
  const config: SpikeConfig = parseArgs(process.argv.slice(2))
  const startedAt = new Date().toISOString()
  await prepareOutDir(config.outDir)

  // --- Resolution and prechecks (shared by dry-run and measurement) ---
  const [binFacts, host, commit] = await Promise.all([
    serverBinFacts(config.serverBin),
    hostIdentity(),
    gitCommit(),
  ])
  const mlxRuntime = await mlxRuntimeIdentity(binFacts.realPath)
  const resolvedSnapshot = await resolveSnapshotPath(config)
  const snapshot = await verifySnapshot(resolvedSnapshot, config.hfRepository, {
    hashWeights: !config.dryRun,
  })
  const portFreeBeforeLaunch = await portIsFree(SPIKE_HOST, SPIKE_PORT)
  if (!portFreeBeforeLaunch) {
    throw new Error(
      `Refusing to launch: ${SPIKE_HOST}:${SPIKE_PORT} is already occupied; ` +
        'the spike only ever owns a listener it spawned itself',
    )
  }
  const memory = await collectHostMemoryFacts()
  const { request, source: requestSource } = await loadRequest(config.requestFile)
  const payload = requestPayload(request)
  const systemPromptSha256 = createHash('sha256').update(SYSTEM_PROMPT).digest('hex')
  const requestPayloadSha256 = canonicalSha256({
    promptVersion: PROMPT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    parameters: { ...SAMPLING, confidenceThreshold: config.confidenceThreshold },
    payload,
  })

  const baseEvidence = {
    config: {
      out_dir: config.outDir,
      dry_run: config.dryRun,
      cancel_after_ms: config.cancelAfterMs ?? null,
      startup_timeout_ms: config.startupTimeoutMs,
      request_timeout_ms: config.requestTimeoutMs,
      confidence_threshold: config.confidenceThreshold,
    },
    host,
    evidence_implementation_commit: commit,
    driver_runtime: {
      node: process.version,
      tsx: await installedPackageVersion('tsx'),
      '@tanstack/ai': await installedPackageVersion('@tanstack/ai'),
      '@tanstack/ai-openai': await installedPackageVersion('@tanstack/ai-openai'),
      zod: await installedPackageVersion('zod'),
      pin_source: 'scripts/gemma-mlx-spike/package.json + package-lock.json (npm, local install)',
    },
    mlx_runtime: {
      server_bin: binFacts,
      identity: mlxRuntime,
    },
    model: snapshot,
    server: {
      host: SPIKE_HOST,
      port: SPIKE_PORT,
      flags_used: ['--model', '--host', '--port', '--log-level'],
      argv: serverArgs(snapshot.snapshotPath),
      port_precheck_free: metric(
        portFreeBeforeLaunch,
        'node:net bind test on 127.0.0.1:8090 before spawn',
        'boolean',
      ),
      log_path: serverLogPath(config.outDir),
      note:
        'mlx_lm.server 0.31.3 has no --context or --concurrency flag. Effective context length ' +
        'comes from the model config (model.max_position_embeddings above); prefill-step-size ' +
        'defaults to 2048; prompt-cache settings are server defaults (no flags passed).',
    },
    request: {
      source: requestSource,
      wire_model_id: SPIKE_WIRE_MODEL_ID,
      prompt_version: PROMPT_VERSION,
      schema_version: SCHEMA_VERSION,
      system_prompt_sha256: systemPromptSha256,
      system_prompt_provenance:
        'verbatim copy of GEMMA_DIRECTOR_SYSTEM_PROMPT (packages/gemma-director/src/profile.ts)',
      request_payload_sha256: requestPayloadSha256,
      sampling: SAMPLING,
      sampling_provenance: 'production SELECTED_GEMMA_PROFILE generation parameters',
      passage_count: request.passages.length,
      speaker_count: request.speakers.length,
    },
    memory: {
      physical_memory: memory.physicalMemoryBytes,
      recommended_max_working_set: memory.recommendedMaxWorkingSetBytes,
      memory_pressure_free_percent_at_start: memory.memoryPressureFreePercent,
      headroom_note:
        'RSS, Metal recommendedMaxWorkingSetSize, and memory pressure are reported as separate ' +
        'labeled quantities. RSS is never labeled as per-process Metal allocation and no ' +
        'headroom figure is derived by subtracting incomparable measurements.',
    },
  }

  const finalize = async (
    phase: SpikeEvidence['phase'],
    result: SpikeEvidence['result'],
    extra: Record<string, unknown>,
  ): Promise<never> => {
    const evidence: SpikeEvidence = {
      schema: 'gemma-mlx-spike-evidence@1',
      issue: 106,
      phase,
      result,
      startedAt,
      completedAt: new Date().toISOString(),
      ...baseEvidence,
      ...extra,
    }
    const path = await writeEvidence(config.outDir, evidence)
    console.log(`evidence: ${path}`)
    console.log(`result: ${result}`)
    process.exit(result === 'client-gates-passed' || result === 'dry-run-ok' || result === 'cancelled-clean' ? 0 : 1)
  }

  if (config.dryRun) {
    await finalize('dry-run', 'dry-run-ok', {
      checks: {
        args_parsed: true,
        server_bin_resolved: true,
        snapshot_resolved_and_verified: true,
        snapshot_weights_hashed: false,
        port_precheck_free: portFreeBeforeLaunch,
        request_constructed: true,
        note:
          'No server was spawned and no model was loaded. Weight shard hashing and the ' +
          'transmitted response_format capture happen only in a measurement run.',
      },
    })
  }

  // --- Measurement run ---
  const server = new OwnedMlxServer({
    serverBin: binFacts.realPath,
    args: serverArgs(snapshot.snapshotPath),
    host: SPIKE_HOST,
    port: SPIKE_PORT,
    logPath: serverLogPath(config.outDir),
    terminateTimeoutMs: config.terminateTimeoutMs,
    killTimeoutMs: config.killTimeoutMs,
    portFreeTimeoutMs: config.portFreeTimeoutMs,
  })

  // Crash paths must never leave the owned server behind.
  const shutdownController = new AbortController()
  let terminatingSignal: string | null = null
  process.once('uncaughtException', (error) => {
    server.forceKillGroupSync()
    console.error(error)
    process.exit(70)
  })
  const onSignal = (signal: 'SIGINT' | 'SIGTERM'): void => {
    terminatingSignal = signal
    shutdownController.abort(new DOMException(`spike received ${signal}`, 'AbortError'))
  }
  process.once('SIGINT', () => onSignal('SIGINT'))
  process.once('SIGTERM', () => onSignal('SIGTERM'))

  let sampler: RssSampler | undefined
  try {
    const spawnAt = performance.now()
    server.start()
    const serverPid = server.processId
    if (serverPid === undefined) throw new Error('Owned mlx_lm.server has no process ID')
    sampler = new RssSampler(serverPid)
    sampler.start()

    const { listenerReadyMs } = await server.waitForListener(config.startupTimeoutMs)
    // /health answers unconditionally and proves nothing about model load; it is recorded only
    // to make the lazy-load delta explicit next to the first-request measurement.
    const healthResponse = await fetch(`http://${SPIKE_HOST}:${SPIKE_PORT}/health`, {
      signal: AbortSignal.timeout(5_000),
    })
    const healthFirstOkMs = healthResponse.ok
      ? Math.round(performance.now() - spawnAt)
      : null

    const baseUrl = `http://${SPIKE_HOST}:${SPIKE_PORT}/v1`
    const runOnce = (name: string): Promise<DirectionRunResult> =>
      runDirection({
        baseUrl,
        request,
        confidenceThreshold: config.confidenceThreshold,
        timeoutMs: config.requestTimeoutMs,
        cancelAfterMs: name === 'cold' ? config.cancelAfterMs : undefined,
        signal: shutdownController.signal,
      })

    // Request 1 is cold: mlx_lm.server loads weights lazily on this first request, so its
    // dispatch-to-first-token time is the cold model load measurement (not /health).
    const coldResult = await runOnce('cold')
    const runs: RunSection[] = [{ name: 'cold', result: coldResult }]
    // Request 2 is warm: representative prompt/generation throughput without load conflation.
    if (config.cancelAfterMs === undefined) {
      runs.push({ name: 'warm', result: await runOnce('warm') })
    }

    const pressureAtPeak = (await collectHostMemoryFacts()).memoryPressureFreePercent
    await sampler.sample()
    sampler.stop()
    const peak = sampler.peak
    const cleanup = await server.shutdown()

    const sections: Record<string, unknown> = {}
    for (const run of runs) sections[run.name] = runSection(run)
    await finalize(config.cancelAfterMs === undefined ? 'measurement' : 'cancellation', 
      cleanup.cleanupVerified ? 'client-gates-passed' : 'client-gates-failed', {
      startup: {
        listener_ready: metric(
          listenerReadyMs,
          'TCP connect poll to the owned 127.0.0.1:8090 listener',
          'ms',
        ),
        health_first_ok: metric(
          healthFirstOkMs,
          'GET /health after listener ready',
          'ms',
          'mlx_lm.server answers /health unconditionally; this is NOT model load. Cold model ' +
            'load is the cold run dispatch-to-first-token measurement.',
        ),
        server_pid: serverPid,
      },
      runs: sections,
      gates: gateSection(runs),
      memory_at_peak: {
        server_family_peak_rss: metric(
          peak.rssBytes,
          'ps -axo pid,ppid,rss family walk, 250 ms sampler',
          'bytes',
          `peak observed ${peak.observedAtMonotonicMs} ms after sampler start across ${peak.samples} samples; ` +
            `family pids at peak: ${peak.familyPids.join(', ')}`,
        ),
        memory_pressure_free_percent_at_peak: pressureAtPeak,
      },
      cleanup: {
        ...cleanup,
        port_free_after: metric(
          cleanup.portFree,
          'node:net bind test after shutdown',
          'boolean',
        ),
        collector: 'process-group SIGTERM, bounded SIGKILL fallback, ps family check, port bind test',
      },
    })
  } catch (error: unknown) {
    sampler?.stop()
    let cleanup: unknown = null
    try {
      cleanup = await server.shutdown()
    } catch (cleanupError: unknown) {
      cleanup = { failed: errorSection(cleanupError) }
    }
    const cancelled =
      error instanceof DirectorError && error.code === 'cancelled'
    const phase =
      config.cancelAfterMs !== undefined || terminatingSignal !== null
        ? 'cancellation'
        : 'measurement'
    const cleanupVerified =
      typeof cleanup === 'object' &&
      cleanup !== null &&
      (cleanup as { cleanupVerified?: boolean }).cleanupVerified === true
    // A rejected client-side gate is a measurement outcome (NO-GO evidence), not a driver error.
    const gateFailure =
      error instanceof DirectorError &&
      (error.code === 'malformed_output' ||
        error.code === 'schema_validation' ||
        error.code === 'fidelity')
    const result =
      cancelled && cleanupVerified
        ? 'cancelled-clean'
        : cancelled
          ? 'error' // cancellation was requested but cleanup could not be verified — never report clean
          : gateFailure
            ? 'client-gates-failed'
            : 'error'
    await finalize(phase, result, {
      error: errorSection(error),
      cancellation: {
        exercised: config.cancelAfterMs !== undefined || terminatingSignal !== null,
        cancel_after_ms: config.cancelAfterMs ?? null,
        terminating_signal: terminatingSignal,
        observed_error_code: error instanceof DirectorError ? error.code : null,
      },
      cleanup: cleanup,
      note:
        cancelled && cleanupVerified
          ? 'Cancellation exercised and owned-server cleanup verified: no descendant, port free.'
          : undefined,
    })
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
