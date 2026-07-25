import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, open, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  canonicalJson,
  canonicalSha256,
  type JsonValue,
  sha256,
} from '@light-novel-audiobook/scoring-harness'
import {
  evidenceBinding,
  syntheticEvidenceSchema,
  verifyEvidenceInternalConsistency,
} from '../src/evidence.js'
import { readImplementationIdentity } from '../src/implementation-identity.js'
import { runExactlyThree } from '../src/orchestrator.js'
import { BENCHMARK_PROFILES } from '../src/profiles.js'
import { withPinnedRuntime } from '../src/runtime.js'
import { benchmarkRunManifestSchema, experimentPlanSchema } from '../src/schemas.js'
import { validateWorkspaceInputs } from '../src/workspace.js'

const execFile = promisify(execFileCallback)
const repositoryRoot = resolve(import.meta.dirname, '../../..')
const evidencePath = resolve(
  repositoryRoot,
  'packages/gemma-benchmark/evidence/synthetic-operational-smoke.json',
)

async function main(): Promise<void> {
  const { stdout: statusOutput } = await execFile('git', ['status', '--porcelain'], {
    cwd: repositoryRoot,
  })
  if (statusOutput.trim() !== '') throw new Error('Evidence requires a clean implementation commit')
  const implementation = await readImplementationIdentity(repositoryRoot)
  const { stdout: gitDirectoryOutput } = await execFile(
    'git',
    ['rev-parse', '--absolute-git-dir'],
    { cwd: repositoryRoot },
  )
  const workspaceRoot = resolve(
    process.env.GEMMA_BENCHMARK_EVIDENCE_WORKSPACE ??
      `${process.env.XDG_DATA_HOME ?? resolve(homedir(), '.local/share')}/light-novel-audiobook/evidence/issue-6/${implementation.commit}`,
  )
  await mkdir(workspaceRoot, { recursive: true, mode: 0o700 })
  const fixtures = resolve(repositoryRoot, 'packages/scoring-harness/test/fixtures')
  const inputs = await validateWorkspaceInputs({
    workspaceRoot,
    repositoryRoot,
    sourcePath: resolve(fixtures, 'source.json'),
    corpusPath: resolve(fixtures, 'corpus.json'),
    annotationsPath: resolve(fixtures, 'annotations.json'),
    contextPath: resolve(
      repositoryRoot,
      'packages/gemma-benchmark/test/fixtures/synthetic-context.json',
    ),
    datasetClass: 'synthetic_operational',
  })
  const profile = BENCHMARK_PROFILES[0]
  if (!profile) throw new Error('Pinned primary profile is missing')
  const runtimeRoot = resolve(
    process.env.GEMMA_BENCHMARK_ROOT ??
      `${process.env.XDG_CACHE_HOME ?? resolve(homedir(), '.cache')}/light-novel-audiobook/issue-6-brain`,
  )
  const port = Number(process.env.GEMMA_BENCHMARK_PORT ?? '18086')
  const execution = await withPinnedRuntime({
    runtimeRoot,
    repositoryRoot,
    gitDirectory: gitDirectoryOutput.trim(),
    profile,
    port,
    run: async (gateway, runtime) =>
      await runExactlyThree({
        experimentId: `synthetic-${implementation.commit.slice(0, 16)}`,
        datasetClass: 'synthetic_operational',
        inputs,
        profile,
        runtime,
        gateway,
      }),
  })
  if (!execution.value.operationalPassed) throw new Error('Synthetic operational smoke failed')

  const planBytes = await readFile(
    resolve(execution.value.experimentRoot, 'experiment-plan.json'),
    'utf8',
  )
  const plan = experimentPlanSchema.parse(JSON.parse(planBytes))
  const reportBytes = await readFile(execution.value.reportPath, 'utf8')
  const report = JSON.parse(reportBytes) as Record<string, unknown>
  const runs = []
  for (let runIndex = 1; runIndex <= 3; runIndex += 1) {
    const bytes = await readFile(
      resolve(execution.value.experimentRoot, `run-${runIndex}.private.json`),
      'utf8',
    )
    const manifest = benchmarkRunManifestSchema.parse(JSON.parse(bytes))
    runs.push({
      run_index: runIndex,
      manifest_file_sha256: sha256(bytes),
      raw_response_sha256: manifest.raw_response_sha256,
      evaluation_run_sha256: canonicalSha256(manifest.evaluation_run as unknown as JsonValue),
      annotations_sha256: manifest.annotations_sha256,
      result_state: manifest.result_state,
      failure_code: manifest.failure_code,
      provider_output_valid: manifest.provider_output_valid,
      resources: manifest.resources,
      child_exit: manifest.child_exit,
      performance: manifest.performance,
      crashed: manifest.evaluation_run.operational.crashed,
      out_of_memory: manifest.evaluation_run.operational.out_of_memory,
    })
  }

  const preimage = {
    schema_version: 'issue-6-synthetic-evidence@2' as const,
    scope: 'synthetic-operational-only-not-representative-accuracy' as const,
    representative_accuracy_claim_permitted: false as const,
    implementation: {
      commit: implementation.commit,
      tree: implementation.tree,
      canonical_source_set_sha256: implementation.canonicalSourceSetSha256,
      source_files: implementation.sourceFiles,
    },
    runtime: {
      host_manifest: execution.context.host,
      host_manifest_file_sha256: execution.context.hostManifestSha256,
      model_sha256: execution.context.host.modelSha256,
      model_size_bytes: execution.context.host.modelSizeBytes,
      binary_sha256: execution.context.host.binarySha256,
      cmake_configuration_sha256: execution.context.host.cmakeConfigurationSha256,
      runtime_configuration_sha256: execution.context.runtimeConfigurationSha256,
      external_root_proof: execution.context.externalRootProof,
      model_bytes_verified: true as const,
      binary_bytes_verified: true as const,
      text_model_only: true as const,
    },
    experiment: {
      plan,
      plan_canonical_sha256: canonicalSha256(plan as unknown as JsonValue),
      plan_file_sha256: sha256(planBytes),
      annotations_sha256: inputs.annotationsSha256,
      runs,
      sanitized_report: report,
      sanitized_report_file_sha256: sha256(reportBytes),
    },
    cleanup: execution.cleanup,
    runtime_lifecycle_passed: true as const,
  }
  const evidence = syntheticEvidenceSchema.parse({
    ...preimage,
    evidence_binding_sha256: evidenceBinding(preimage),
  })
  verifyEvidenceInternalConsistency(evidence)
  await mkdir(resolve(evidencePath, '..'), { recursive: true })
  const handle = await open(evidencePath, 'wx', 0o644)
  try {
    await handle.writeFile(`${canonicalJson(evidence as unknown as JsonValue)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  if ((await stat(evidencePath)).size === 0) throw new Error('Evidence file is empty')
  process.stdout.write(
    'Synthetic operational evidence recorded; no representative accuracy claim.\n',
  )
}

await main()
