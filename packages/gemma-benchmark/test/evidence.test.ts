import { execFile as execFileCallback } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  canonicalJson,
  canonicalSha256,
  type JsonValue,
  sha256,
} from '@light-novel-audiobook/scoring-harness'
import { describe, expect, it } from 'vitest'
import {
  evidenceBinding,
  type SyntheticEvidence,
  syntheticEvidenceSchema,
  verifyEvidenceInternalConsistency,
  verifyPassingCleanupEvidence,
  verifySyntheticAnnotationFixtureIdentity,
} from '../src/evidence.js'
import type { RuntimeCleanupEvidence } from '../src/schemas.js'

const execFile = promisify(execFileCallback)
const packageRoot = resolve(import.meta.dirname, '..')
const evidencePath = resolve(packageRoot, 'evidence/synthetic-operational-smoke.json')

describe('committed issue #6 synthetic evidence', () => {
  it('rejects late-exit and crash cleanup for evidence claiming an operational pass', () => {
    const graceful: RuntimeCleanupEvidence = {
      schema_version: 'runtime-cleanup@1',
      child_exit_observed: true,
      exit_code: 0,
      signal: null,
      termination: 'sigterm',
      sigterm_sent: true,
      sigkill_sent: false,
      exit_awaited: true,
      api_key_file_removed: true,
      port_released: true,
    }
    expect(() => verifyPassingCleanupEvidence(graceful)).not.toThrow()
    for (const cleanup of [
      { ...graceful, termination: 'already_exited', sigterm_sent: false, exit_code: 137 },
      { ...graceful, exit_code: 137 },
      { ...graceful, exit_code: null, signal: 'SIGKILL' },
    ] satisfies RuntimeCleanupEvidence[]) {
      expect(() => verifyPassingCleanupEvidence(cleanup)).toThrow('graceful owned shutdown')
    }
  })
  it.skipIf(!existsSync(evidencePath))(
    'rejects an annotation substitution that recomputes every former outer binding',
    async () => {
      const original = syntheticEvidenceSchema.parse(
        JSON.parse(await readFile(evidencePath, 'utf8')),
      )
      const attack = structuredClone(original) as SyntheticEvidence
      const substituted = 'a'.repeat(64)
      attack.experiment.plan.annotations_sha256 = substituted
      attack.experiment.plan_canonical_sha256 = canonicalSha256(
        attack.experiment.plan as unknown as JsonValue,
      )
      attack.experiment.plan_file_sha256 = sha256(
        `${canonicalJson(attack.experiment.plan as unknown as JsonValue)}\n`,
      )
      attack.experiment.annotations_sha256 = substituted
      for (const run of attack.experiment.runs) run.annotations_sha256 = substituted
      const report = attack.experiment.sanitized_report as {
        annotations_sha256: string
        plan_sha256: string
        scoring: { identities: { annotation_sha256: string } }
      }
      report.annotations_sha256 = substituted
      report.plan_sha256 = attack.experiment.plan_canonical_sha256
      attack.experiment.sanitized_report_file_sha256 = sha256(
        `${canonicalJson(report as unknown as JsonValue)}\n`,
      )
      const { evidence_binding_sha256: _, ...preimage } = attack
      attack.evidence_binding_sha256 = evidenceBinding(preimage)
      expect(() => verifyEvidenceInternalConsistency(attack)).toThrow(
        'scoring annotation identity mismatch',
      )

      report.scoring.identities.annotation_sha256 = substituted
      attack.experiment.sanitized_report_file_sha256 = sha256(
        `${canonicalJson(report as unknown as JsonValue)}\n`,
      )
      const { evidence_binding_sha256: __, ...fullySubstitutedPreimage } = attack
      attack.evidence_binding_sha256 = evidenceBinding(fullySubstitutedPreimage)
      expect(() => verifyEvidenceInternalConsistency(attack)).not.toThrow()
      const fixture = JSON.parse(
        await readFile(
          resolve(packageRoot, '../scoring-harness/test/fixtures/annotations.json'),
          'utf8',
        ),
      ) as JsonValue
      expect(() => verifySyntheticAnnotationFixtureIdentity(attack, fixture)).toThrow(
        'fixture identity mismatch',
      )
    },
  )
  it.skipIf(!existsSync(evidencePath))(
    'recomputes every committed binding and remains synthetic-only',
    async () => {
      const { stdout } = await execFile('node', ['--import', 'tsx', 'scripts/verify-evidence.ts'], {
        cwd: packageRoot,
      })
      expect(stdout).toContain('current and sanitized')
    },
  )
})
