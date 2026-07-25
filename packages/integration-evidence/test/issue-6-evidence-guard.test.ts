import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  issue6VerifierDiffSha256,
  issue6VerifierPath,
  readUnapprovedIssue6Changes,
} from '../../gemma-benchmark/scripts/verify-evidence.js'

const execFile = promisify(execFileCallback)
const repositories: string[] = []

async function git(repository: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFile('git', [...args], { cwd: repository })
  return stdout
}

async function write(repository: string, path: string, content: string): Promise<void> {
  const absolute = join(repository, path)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, content)
}

async function commit(repository: string, message: string): Promise<string> {
  await git(repository, ['add', '.'])
  await git(repository, ['commit', '-m', message])
  return (await git(repository, ['rev-parse', 'HEAD'])).trim()
}

afterEach(async () => {
  await Promise.all(
    repositories.splice(0).map(async (repository) => {
      await rm(repository, { recursive: true, force: true })
    }),
  )
})

describe('issue #6 historical evidence drift guard', () => {
  it('allows unrelated merged work and only the pinned verifier migration', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'issue-6-evidence-guard-'))
    repositories.push(repository)
    await git(repository, ['init'])
    await git(repository, ['config', 'user.name', 'Fixture'])
    await git(repository, ['config', 'user.email', 'fixture@example.invalid'])
    await Promise.all([
      write(repository, issue6VerifierPath, 'export const verifier = 1\n'),
      write(repository, 'packages/gemma-benchmark/src/orchestrator.ts', 'export const run = 1\n'),
      write(repository, 'packages/gemma-benchmark/evidence/run.json', '{"run":1}\n'),
      write(repository, 'packages/scoring-harness/package.json', '{"private":true}\n'),
      write(repository, 'packages/scoring-harness/src/index.ts', 'export const index = 1\n'),
      write(repository, 'packages/scoring-harness/src/scorer.ts', 'export const score = 1\n'),
      write(repository, 'schemas/evaluation/benchmark-context.schema.json', '{"version":1}\n'),
    ])
    const implementationCommit = await commit(repository, 'issue 6 implementation')

    await Promise.all([
      write(repository, issue6VerifierPath, 'export const verifier = 2\n'),
      write(repository, 'packages/gemma-benchmark/evidence/run.json', '{"run":2}\n'),
      write(repository, 'packages/issue-7/runtime.ts', 'export const unrelated = true\n'),
      write(repository, 'package.json', '{"private":true,"merged":7}\n'),
    ])
    const mergedCommit = await commit(repository, 'merge unrelated issue and verifier migration')
    const authorization = {
      [issue6VerifierPath]: await issue6VerifierDiffSha256(
        repository,
        implementationCommit,
        mergedCommit,
      ),
    }
    expect(
      await readUnapprovedIssue6Changes(
        repository,
        implementationCommit,
        mergedCommit,
        authorization,
      ),
    ).toEqual([])

    await write(
      repository,
      'packages/gemma-benchmark/src/orchestrator.ts',
      'export const run = 2\n',
    )
    const sourceDrift = await commit(repository, 'edit issue 6 source')
    expect(
      await readUnapprovedIssue6Changes(
        repository,
        implementationCommit,
        sourceDrift,
        authorization,
      ),
    ).toContain('packages/gemma-benchmark/src/orchestrator.ts')

    await git(repository, ['reset', '--hard', mergedCommit])
    await write(repository, 'packages/scoring-harness/src/scorer.ts', 'export const score = 2\n')
    const scorerDrift = await commit(repository, 'edit issue 6 scoring surface')
    expect(
      await readUnapprovedIssue6Changes(
        repository,
        implementationCommit,
        scorerDrift,
        authorization,
      ),
    ).toContain('packages/scoring-harness/src/scorer.ts')

    await git(repository, ['reset', '--hard', mergedCommit])
    await write(repository, 'schemas/evaluation/benchmark-context.schema.json', '{"version":2}\n')
    const schemaDrift = await commit(repository, 'edit issue 6 schema')
    expect(
      await readUnapprovedIssue6Changes(
        repository,
        implementationCommit,
        schemaDrift,
        authorization,
      ),
    ).toContain('schemas/evaluation/benchmark-context.schema.json')

    await git(repository, ['reset', '--hard', mergedCommit])
    await write(repository, issue6VerifierPath, 'export const verifier = 3\n')
    const verifierDrift = await commit(repository, 'edit verifier again')
    expect(
      await readUnapprovedIssue6Changes(
        repository,
        implementationCommit,
        verifierDrift,
        authorization,
      ),
    ).toContain(issue6VerifierPath)
  })
})
