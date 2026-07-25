import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

const CANONICAL_PATHS = [
  '.github/workflows/ci.yml',
  '.gitignore',
  '.node-version',
  '.npmrc',
  'AGENTS.md',
  'biome.json',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'vitest.config.ts',
  'docs/PLAN.md',
  'docs/evaluation',
  'schemas/evaluation',
  'packages/scoring-harness',
  'packages/gemma-benchmark',
] as const

export interface ImplementationIdentity {
  readonly commit: string
  readonly tree: string
  readonly canonicalSourceSetSha256: string
  readonly sourceFiles: readonly string[]
}

export async function readImplementationIdentity(
  repositoryRoot: string,
  revision = 'HEAD',
): Promise<ImplementationIdentity> {
  const { stdout: commitOutput } = await execFile('git', ['rev-parse', `${revision}^{commit}`], {
    cwd: repositoryRoot,
  })
  const commit = commitOutput.trim()
  const { stdout: treeOutput } = await execFile('git', ['rev-parse', `${commit}^{tree}`], {
    cwd: repositoryRoot,
  })
  const { stdout: listingOutput } = await execFile(
    'git',
    ['ls-tree', '-r', '--full-tree', commit, '--', ...CANONICAL_PATHS],
    { cwd: repositoryRoot },
  )
  const lines = listingOutput
    .split('\n')
    .filter(Boolean)
    .filter((line) => !line.includes('\tpackages/gemma-benchmark/evidence/'))
  if (lines.length === 0) throw new Error('Canonical Gemma benchmark source set is empty')
  const sourceFiles = lines.map((line) => {
    const separator = line.indexOf('\t')
    if (separator === -1) throw new Error('Unexpected git ls-tree output')
    return line.slice(separator + 1)
  })
  return {
    commit,
    tree: treeOutput.trim(),
    canonicalSourceSetSha256: createHash('sha256')
      .update(`${lines.join('\n')}\n`)
      .digest('hex'),
    sourceFiles,
  }
}
