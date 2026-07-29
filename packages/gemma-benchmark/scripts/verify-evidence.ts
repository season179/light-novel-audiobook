import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { canonicalJson, type JsonValue, sha256 } from '@light-novel-audiobook/scoring-harness'
import {
  syntheticEvidenceSchema,
  verifyEvidenceInternalConsistency,
  verifySyntheticAnnotationFixtureIdentity,
} from '../src/evidence.js'
import { readImplementationIdentity } from '../src/implementation-identity.js'
import { BENCHMARK_PROFILES } from '../src/profiles.js'

const execFile = promisify(execFileCallback)
const benchmarkRoot = 'packages/gemma-benchmark'
const benchmarkEvidenceRoot = `${benchmarkRoot}/evidence/`
export const issue6VerifierPath = `${benchmarkRoot}/scripts/verify-evidence.ts`
export const issue6PackagingPaths = [
  `${benchmarkRoot}/package.json`,
  'packages/scoring-harness/package.json',
] as const
export const issue6ScopedPaths = [
  benchmarkRoot,
  'packages/scoring-harness/package.json',
  'packages/scoring-harness/src/index.ts',
  'packages/scoring-harness/src/scorer.ts',
  'schemas/evaluation/benchmark-context.schema.json',
] as const

async function gitOutput(repository: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFile('git', [...args], { cwd: repository })
  return stdout
}

export async function issue6PathDiffSha256(
  repository: string,
  implementationCommit: string,
  currentRevision: string,
  path: string,
): Promise<string> {
  const patch = await gitOutput(repository, [
    'diff',
    '--no-renames',
    '--full-index',
    implementationCommit,
    currentRevision,
    '--',
    path,
  ])
  return createHash('sha256').update(patch).digest('hex')
}

export async function issue6VerifierDiffSha256(
  repository: string,
  implementationCommit: string,
  currentRevision: string,
): Promise<string> {
  return await issue6PathDiffSha256(
    repository,
    implementationCommit,
    currentRevision,
    issue6VerifierPath,
  )
}

export async function readUnapprovedIssue6Changes(
  repository: string,
  implementationCommit: string,
  currentRevision: string,
  authorizedMigrationPatches: Readonly<Record<string, string>>,
): Promise<readonly string[]> {
  const names = await gitOutput(repository, [
    'diff',
    '--name-only',
    '--no-renames',
    '-z',
    implementationCommit,
    currentRevision,
    '--',
    ...issue6ScopedPaths,
  ])
  const changes = names
    .split('\0')
    .filter(Boolean)
    .filter((path) => !path.startsWith(benchmarkEvidenceRoot))
  const unapproved: string[] = []
  for (const path of changes) {
    const expectedPatch = authorizedMigrationPatches[path]
    if (
      !expectedPatch ||
      (await issue6PathDiffSha256(repository, implementationCommit, currentRevision, path)) !==
        expectedPatch
    ) {
      unapproved.push(path)
    }
  }
  return unapproved.sort()
}

interface EvidenceGuard {
  readonly schemaVersion: 2
  readonly implementationCommit: string
  readonly authorizedMigrationPatches: Readonly<Record<string, string>>
}

function parseEvidenceGuard(value: unknown): EvidenceGuard {
  const guard = value as Partial<EvidenceGuard>
  const patches = guard.authorizedMigrationPatches
  const expectedPaths = [
    issue6VerifierPath,
    ...issue6PackagingPaths,
    `${benchmarkRoot}/src/evidence.ts`,
    `${benchmarkRoot}/src/index.ts`,
    `${benchmarkRoot}/src/orchestrator.ts`,
    `${benchmarkRoot}/src/path-safety.ts`,
    `${benchmarkRoot}/src/runtime.ts`,
    `${benchmarkRoot}/test/benchmark.test.ts`,
    `${benchmarkRoot}/test/evidence.test.ts`,
    `${benchmarkRoot}/test/platform-manifest.test.ts`,
    `${benchmarkRoot}/test/runtime-safety.test.ts`,
  ].sort()
  if (
    typeof guard !== 'object' ||
    guard === null ||
    guard.schemaVersion !== 2 ||
    typeof guard.implementationCommit !== 'string' ||
    !/^[a-f0-9]{40}$/.test(guard.implementationCommit) ||
    typeof patches !== 'object' ||
    patches === null ||
    Array.isArray(patches) ||
    JSON.stringify(Object.keys(patches).sort()) !== JSON.stringify(expectedPaths) ||
    expectedPaths.some(
      (path) => typeof patches[path] !== 'string' || !/^[a-f0-9]{64}$/.test(patches[path] ?? ''),
    )
  ) {
    throw new Error('Issue #6 evidence guard is invalid')
  }
  return guard as EvidenceGuard
}

export async function verifyCommittedIssue6Evidence(repositoryRoot: string): Promise<void> {
  const evidencePath = resolve(
    repositoryRoot,
    'packages/gemma-benchmark/evidence/synthetic-operational-smoke.json',
  )
  const guardPath = resolve(repositoryRoot, 'config/issue-6-evidence-guard.json')
  const evidence = syntheticEvidenceSchema.parse(JSON.parse(await readFile(evidencePath, 'utf8')))
  const guard = parseEvidenceGuard(JSON.parse(await readFile(guardPath, 'utf8')))
  verifyEvidenceInternalConsistency(evidence)
  await execFile('git', ['merge-base', '--is-ancestor', evidence.implementation.commit, 'HEAD'], {
    cwd: repositoryRoot,
  })

  const recorded = await readImplementationIdentity(repositoryRoot, evidence.implementation.commit)
  if (
    recorded.commit !== evidence.implementation.commit ||
    recorded.tree !== evidence.implementation.tree ||
    recorded.canonicalSourceSetSha256 !== evidence.implementation.canonical_source_set_sha256 ||
    JSON.stringify(recorded.sourceFiles) !== JSON.stringify(evidence.implementation.source_files)
  ) {
    throw new Error('Historical implementation identity does not match synthetic evidence')
  }
  if (guard.implementationCommit !== evidence.implementation.commit) {
    throw new Error('Issue #6 evidence guard targets the wrong implementation')
  }
  const unapprovedChanges = await readUnapprovedIssue6Changes(
    repositoryRoot,
    evidence.implementation.commit,
    'HEAD',
    guard.authorizedMigrationPatches,
  )
  if (unapprovedChanges.length > 0) {
    throw new Error(
      `Issue #6 implementation drift is not authorized: ${unapprovedChanges.join(', ')}`,
    )
  }

  const { stdout: annotationFixtureBytes } = await execFile(
    'git',
    [
      'show',
      `${evidence.implementation.commit}:packages/scoring-harness/test/fixtures/annotations.json`,
    ],
    { cwd: repositoryRoot },
  )
  verifySyntheticAnnotationFixtureIdentity(
    evidence,
    JSON.parse(annotationFixtureBytes) as JsonValue,
  )

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
    'packages/scoring-harness/test/fixtures/annotations.json',
    'pnpm-lock.yaml',
  ]
  if (requiredSources.some((path) => !evidence.implementation.source_files.includes(path))) {
    throw new Error('Evidence canonical source set is incomplete')
  }
}

const repositoryRoot = resolve(import.meta.dirname, '../../..')
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyCommittedIssue6Evidence(repositoryRoot)
  process.stdout.write('Committed synthetic operational evidence is current and sanitized.\n')
}
