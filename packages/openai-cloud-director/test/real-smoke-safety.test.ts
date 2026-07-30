import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('real smoke safety', () => {
  it('loads root .env without shell sourcing and fails safely before network when key is explicitly blank', async () => {
    const result = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', path.join(PACKAGE_ROOT, 'scripts/real-smoke.ts')],
      {
        cwd: PACKAGE_ROOT,
        env: { ...process.env, OPENAI_API_KEY: '' },
      },
    ).then(
      () => undefined,
      (error: unknown) => error as { code?: number; stdout?: string; stderr?: string },
    )

    expect(result).toMatchObject({ code: 1, stdout: '' })
    const failure = JSON.parse(result?.stderr?.trim() ?? '') as Record<string, unknown>
    expect(failure).toEqual({
      schema: 'openai-cloud-director-real-smoke@1',
      ok: false,
      code: 'configuration',
      message: 'OPENAI_API_KEY is required for the OpenAI cloud director real smoke',
      retryable: false,
    })
    expect(result?.stderr).not.toContain('A bell rang once.')
    expect(result?.stderr).not.toContain('reasoning')
    expect(result?.stderr).not.toContain('provider')
  })
})
