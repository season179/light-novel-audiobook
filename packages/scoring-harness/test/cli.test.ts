import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const testRoot = path.dirname(fileURLToPath(import.meta.url))
const fixtureRoot = path.join(testRoot, 'fixtures')
const cliPath = path.resolve(testRoot, '../src/cli.ts')
const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'audiobook-score-cli-'))
  temporaryDirectories.push(directory)
  return directory
}

function validArguments(output: string): string[] {
  return [
    '--source',
    path.join(fixtureRoot, 'source.json'),
    '--corpus',
    path.join(fixtureRoot, 'corpus.json'),
    '--annotations',
    path.join(fixtureRoot, 'annotations.json'),
    '--runs',
    path.join(fixtureRoot, 'run-1.json'),
    path.join(fixtureRoot, 'run-2.json'),
    path.join(fixtureRoot, 'run-3.json'),
    '--output',
    output,
  ]
}

function runCli(arguments_: readonly string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', cliPath, ...arguments_], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

describe('scoring CLI errors', () => {
  it('returns one generic path-, snippet-, and stack-free error for malformed JSON', async () => {
    const directory = await temporaryDirectory()
    const secretPath = path.join(directory, 'private-book-title-source.json')
    const secretSnippet = 'COPYRIGHTED_STORY_SNIPPET'
    await writeFile(secretPath, `{"text":"${secretSnippet}"`)
    const output = path.join(directory, 'private-report.json')
    const arguments_ = validArguments(output)
    arguments_[1] = secretPath

    const result = runCli(arguments_)
    expect(result.status).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('Evaluation scoring failed.\n')
    expect(result.stderr).not.toContain(secretPath)
    expect(result.stderr).not.toContain(secretSnippet)
    expect(result.stderr).not.toContain('cli.ts')
    expect(result.stderr).not.toContain(' at ')
  })

  it('does not expose an output path or stack when deterministic no-overwrite fails', async () => {
    const directory = await temporaryDirectory()
    const secretOutput = path.join(directory, 'private-book-title-existing-report.json')
    await writeFile(secretOutput, 'already exists')

    const result = runCli(validArguments(secretOutput))
    expect(result.status).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('Evaluation scoring failed.\n')
    expect(result.stderr).not.toContain(secretOutput)
    expect(result.stderr).not.toContain('EEXIST')
    expect(result.stderr).not.toContain(' at ')
  })
})
