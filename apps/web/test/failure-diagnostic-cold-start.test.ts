import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AudiobookJob } from '@light-novel-audiobook/domain'
import {
  DirectorFidelityExhaustedError,
  type FidelityFinding,
  type FidelityRecoveryAttempt,
} from '@light-novel-audiobook/gemma-director'
import { layoutFor, openWorkspace, SqliteJobRepository } from '@light-novel-audiobook/persistence'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('failure diagnosis after a cold start', () => {
  it('reloads the job-to-artifact link and the nested, redacted domain error from SQLite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lna-failure-cold-start-'))
    roots.push(root)
    const sentinel = 'SENTINEL_PRIVATE_PASSAGE_FOR_COLD_START_97'
    const findings = [
      {
        code: 'text_omission',
        sourcePassageId: 'passage-synthetic-cold-start',
        message: 'Model output omits text from the immutable source passage',
        source_text: sentinel,
      },
    ] as unknown as readonly FidelityFinding[]
    const attempts: readonly FidelityRecoveryAttempt[] = [
      {
        attemptNumber: 3,
        sampling: {
          seed: 103,
          temperature: 0.4,
          topP: 0.9,
          maxTokens: 4096,
          confidenceThreshold: 0.5,
        },
        requestSha256: 'a'.repeat(64),
        rawOutputSha256: 'b'.repeat(64),
        validatedOutputSha256: 'c'.repeat(64),
        findingCodes: ['text_omission'],
        sourcePassageIds: ['passage-synthetic-cold-start'],
      },
    ]
    const domainError = new DirectorFidelityExhaustedError(findings, attempts)
    const caught = new Error('Sanitized adapter boundary', {
      cause: new Error('Director request boundary', { cause: domainError }),
    })

    const firstDatabase = openWorkspace(layoutFor(root))
    const firstRepository = new SqliteJobRepository(layoutFor(root), firstDatabase)
    const job = new AudiobookJob('job-cold-start-diagnostic')
    job.bindCommand('d'.repeat(64))
    job.start()
    await firstRepository.saveJob(job)
    const artifactPath = await firstRepository.saveFailureDiagnostic(job.id, caught)
    expect(artifactPath).toBeDefined()
    job.fail(
      `The local server hit an unexpected error. Diagnostic details: ${artifactPath as string}`,
      artifactPath as string,
    )
    await firstRepository.saveJob(job)
    firstDatabase.close()

    // New database handle and repository: no process-local object or terminal scrollback survives.
    const reopenedDatabase = openWorkspace(layoutFor(root))
    try {
      const reopenedRepository = new SqliteJobRepository(layoutFor(root), reopenedDatabase)
      const reloaded = await reopenedRepository.findJob(job.id)
      expect(reloaded?.state).toBe('failed')
      expect(reloaded?.failureDiagnosticPath).toBe(artifactPath)
      expect(reloaded?.error).toContain(artifactPath)

      const persisted = await readFile(artifactPath as string, 'utf8')
      expect(persisted).not.toContain(sentinel)
      expect(persisted).toContain(createHash('sha256').update(sentinel).digest('hex'))
      expect(JSON.parse(persisted)).toMatchObject({
        jobId: job.id,
        error: {
          cause: {
            cause: {
              name: 'DirectorFidelityExhaustedError',
              findings: [{ code: 'text_omission' }],
              attempts: [{ sampling: { seed: 103 }, rawOutputSha256: 'b'.repeat(64) }],
            },
          },
        },
      })
    } finally {
      reopenedDatabase.close()
    }
  })
})
