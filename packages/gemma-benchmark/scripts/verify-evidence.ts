import { execFile as execFileCallback } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { canonicalJson, type JsonValue, sha256 } from '@light-novel-audiobook/scoring-harness'
import { syntheticEvidenceSchema, verifyEvidenceInternalConsistency } from '../src/evidence.js'
import { readImplementationIdentity } from '../src/implementation-identity.js'
import { BENCHMARK_PROFILES } from '../src/profiles.js'

const execFile = promisify(execFileCallback)
const repositoryRoot = resolve(import.meta.dirname, '../../..')
const evidencePath = resolve(
  repositoryRoot,
  'packages/gemma-benchmark/evidence/synthetic-operational-smoke.json',
)

const evidence = syntheticEvidenceSchema.parse(JSON.parse(await readFile(evidencePath, 'utf8')))
verifyEvidenceInternalConsistency(evidence)
await execFile('git', ['merge-base', '--is-ancestor', evidence.implementation.commit, 'HEAD'], {
  cwd: repositoryRoot,
})
const recorded = await readImplementationIdentity(repositoryRoot, evidence.implementation.commit)
const current = await readImplementationIdentity(repositoryRoot)
if (
  recorded.commit !== evidence.implementation.commit ||
  recorded.tree !== evidence.implementation.tree ||
  recorded.canonicalSourceSetSha256 !== evidence.implementation.canonical_source_set_sha256 ||
  JSON.stringify(recorded.sourceFiles) !== JSON.stringify(evidence.implementation.source_files) ||
  current.canonicalSourceSetSha256 !== recorded.canonicalSourceSetSha256 ||
  JSON.stringify(current.sourceFiles) !== JSON.stringify(recorded.sourceFiles)
) {
  throw new Error('Committed implementation no longer matches synthetic evidence')
}
const profile = BENCHMARK_PROFILES[0]
if (
  !profile ||
  evidence.runtime.model_sha256 !== profile.modelSha256 ||
  evidence.runtime.host_manifest.modelSha256 !== profile.modelSha256 ||
  evidence.runtime.host_manifest.modelRevision !== profile.revision ||
  evidence.runtime.binary_sha256 !== evidence.runtime.host_manifest.binarySha256 ||
  evidence.runtime.cmake_configuration_sha256 !==
    evidence.runtime.host_manifest.cmakeConfigurationSha256 ||
  evidence.runtime.runtime_configuration_sha256 !==
    evidence.experiment.plan.runtime_configuration_sha256 ||
  evidence.runtime.host_manifest_file_sha256 !== evidence.experiment.plan.host_manifest_sha256 ||
  evidence.runtime.binary_sha256 !== evidence.experiment.plan.runtime_binary_sha256
) {
  throw new Error('Runtime/model/build evidence identity mismatch')
}
const reportCanonicalBytes = `${canonicalJson(evidence.experiment.sanitized_report as JsonValue)}\n`
if (sha256(reportCanonicalBytes) !== evidence.experiment.sanitized_report_file_sha256) {
  throw new Error('Embedded sanitized report file hash mismatch')
}
const planCanonicalBytes = `${canonicalJson(evidence.experiment.plan as unknown as JsonValue)}\n`
if (sha256(planCanonicalBytes) !== evidence.experiment.plan_file_sha256) {
  throw new Error('Embedded experiment plan file hash mismatch')
}
const requiredSources = [
  '.github/workflows/ci.yml',
  'packages/gemma-benchmark/src/orchestrator.ts',
  'packages/gemma-benchmark/src/gateway.ts',
  'packages/gemma-benchmark/src/runtime.ts',
  'packages/gemma-benchmark/scripts/prepare-host.sh',
  'packages/gemma-benchmark/scripts/record-synthetic-evidence.ts',
  'packages/gemma-benchmark/scripts/verify-evidence.ts',
  'packages/gemma-benchmark/provenance.json',
  'packages/scoring-harness/src/scorer.ts',
  'pnpm-lock.yaml',
]
if (requiredSources.some((path) => !evidence.implementation.source_files.includes(path))) {
  throw new Error('Evidence canonical source set is incomplete')
}
process.stdout.write('Committed synthetic operational evidence is current and sanitized.\n')
