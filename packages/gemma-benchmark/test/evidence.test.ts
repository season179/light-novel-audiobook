import { execFile as execFileCallback } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFile = promisify(execFileCallback)
const packageRoot = resolve(import.meta.dirname, '..')
const evidencePath = resolve(packageRoot, 'evidence/synthetic-operational-smoke.json')

describe('committed issue #6 synthetic evidence', () => {
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
