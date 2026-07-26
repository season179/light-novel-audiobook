/**
 * The proof and listening scripts are never executed by `pnpm check`, so a top-level defect in one
 * of them — a missing import, a renamed export, a typo in the entry guard — stays invisible until
 * someone tries to prove something with it. That happened: the #84 merge added an argv entry guard
 * using `fileURLToPath` without importing it, and `scripts/proof-m1.sh` threw `ReferenceError`
 * before its first check while the gate stayed green.
 *
 * The cheapest possible cover: every script is invoked with a flag it must reject. Module
 * evaluation and the entry guard run in full, argument parsing then refuses, and nothing else
 * happens — no workspace, no dev server, no GPU. A top-level `ReferenceError` cannot hide from it.
 *
 * The assertion is deliberately two-sided. Requiring only "non-zero exit" would pass on the
 * ReferenceError this test exists to catch, since that also exits non-zero.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** Scripts that parse arguments before doing any work, so a bad flag is a safe probe. */
const SCRIPTS = ['proof-m1.mjs', 'listening-run.mjs', 'proof-real-slice.mjs'] as const

const runWithBadFlag = (script: string) =>
  new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join('scripts', script), '--lna-invalid-flag'], {
      cwd: REPOSITORY_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      output += String(chunk)
    })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, output }))
  })

describe('executable scripts evaluate and reach their own argument parsing', () => {
  for (const script of SCRIPTS) {
    it(`${script} rejects an unknown flag instead of failing at module scope`, async () => {
      const { code, output } = await runWithBadFlag(script)

      // The defect this test exists to catch: anything thrown while the module body evaluates.
      expect(output).not.toMatch(/ReferenceError|SyntaxError|ERR_MODULE_NOT_FOUND/)
      // And the script really did reach its own parser, rather than exiting for some other reason.
      expect(output).toContain('unknown argument: --lna-invalid-flag')
      expect(code).not.toBe(0)
    })
  }
})
