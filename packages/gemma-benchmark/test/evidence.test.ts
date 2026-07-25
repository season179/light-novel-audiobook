import { execFile as execFileCallback } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { verifyPassingCleanupEvidence } from '../src/evidence.js'
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
    'recomputes every committed binding and remains synthetic-only',
    async () => {
      const { stdout } = await execFile('node', ['--import', 'tsx', 'scripts/verify-evidence.ts'], {
        cwd: packageRoot,
      })
      expect(stdout).toContain('current and sanitized')
    },
  )
})
