import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { canonicalSha256 } from '@light-novel-audiobook/scoring-harness'
import { afterEach, describe, expect, it } from 'vitest'
import { validateWorkspaceInputs } from '../src/workspace.js'

const roots: string[] = []
const repositoryRoot = resolve(import.meta.dirname, '../../..')
const scoringFixtures = join(repositoryRoot, 'packages/scoring-harness/test/fixtures')
const context = join(import.meta.dirname, 'fixtures/synthetic-context.json')

async function workspace(mode = 0o700): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gemma-workspace-'))
  roots.push(root)
  await chmod(root, mode)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('workspace input boundary', () => {
  it('accepts a lawful external private hash chain with blind independent gold', async () => {
    const root = await workspace()
    const source = JSON.parse(await readFile(join(scoringFixtures, 'source.json'), 'utf8'))
    source.provenance = {
      origin: 'permissively_licensed',
      redistribution: 'workspace_only',
      license: 'CC0-1.0',
      contains_personal_data: false,
    }
    const sourceHash = canonicalSha256(source)
    const corpus = JSON.parse(await readFile(join(scoringFixtures, 'corpus.json'), 'utf8'))
    corpus.source_sha256 = sourceHash
    corpus.storage_class = 'workspace_private'
    const corpusHash = canonicalSha256(corpus)
    const annotations = JSON.parse(
      await readFile(join(scoringFixtures, 'annotations.json'), 'utf8'),
    )
    annotations.source_sha256 = sourceHash
    annotations.corpus_sha256 = corpusHash
    const contextValue = JSON.parse(await readFile(context, 'utf8'))
    contextValue.source_sha256 = sourceHash
    contextValue.corpus_sha256 = corpusHash
    contextValue.governance.redistribution = 'workspace_only'
    const values = { source, corpus, annotations, context: contextValue }
    for (const [name, value] of Object.entries(values)) {
      await writeFile(join(root, `${name}.json`), JSON.stringify(value), { mode: 0o600 })
    }
    const validated = await validateWorkspaceInputs({
      workspaceRoot: root,
      repositoryRoot,
      sourcePath: join(root, 'source.json'),
      corpusPath: join(root, 'corpus.json'),
      annotationsPath: join(root, 'annotations.json'),
      contextPath: join(root, 'context.json'),
      datasetClass: 'private_representative',
    })
    expect(validated.corpus.storage_class).toBe('workspace_private')
  })

  it('accepts only explicitly synthetic committed fixtures in smoke mode', async () => {
    const root = await workspace()
    const validated = await validateWorkspaceInputs({
      workspaceRoot: root,
      repositoryRoot,
      sourcePath: join(scoringFixtures, 'source.json'),
      corpusPath: join(scoringFixtures, 'corpus.json'),
      annotationsPath: join(scoringFixtures, 'annotations.json'),
      contextPath: context,
      datasetClass: 'synthetic_operational',
    })
    expect(validated.corpus.storage_class).toBe('committed_synthetic')
  })

  it('rejects workspace permissions accessible by another user class', async () => {
    const root = await workspace(0o755)
    await expect(
      validateWorkspaceInputs({
        workspaceRoot: root,
        repositoryRoot,
        sourcePath: join(scoringFixtures, 'source.json'),
        corpusPath: join(scoringFixtures, 'corpus.json'),
        annotationsPath: join(scoringFixtures, 'annotations.json'),
        contextPath: context,
        datasetClass: 'synthetic_operational',
      }),
    ).rejects.toThrow('permissions')
  })

  it('rejects committed synthetic data as representative private input', async () => {
    const root = await workspace()
    await expect(
      validateWorkspaceInputs({
        workspaceRoot: root,
        repositoryRoot,
        sourcePath: join(scoringFixtures, 'source.json'),
        corpusPath: join(scoringFixtures, 'corpus.json'),
        annotationsPath: join(scoringFixtures, 'annotations.json'),
        contextPath: context,
        datasetClass: 'private_representative',
      }),
    ).rejects.toThrow()
  })
})
