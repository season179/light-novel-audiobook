import { execFile as execFileCallback } from 'node:child_process'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import {
  canonicalSha256,
  type EvaluationSource,
  type GoldAnnotations,
  type RepresentativeCorpus,
  validateEvaluationGovernance,
} from '@light-novel-audiobook/scoring-harness'
import { type BenchmarkContext, benchmarkContextSchema } from './schemas.js'

const execFile = promisify(execFileCallback)

function contains(parent: string, candidate: string): boolean {
  const difference = relative(parent, candidate)
  return (
    difference === '' ||
    (!difference.startsWith(`..${sep}`) && difference !== '..' && !isAbsolute(difference))
  )
}

async function requirePrivateMode(path: string, directory: boolean): Promise<void> {
  const details = await stat(path)
  if (directory !== details.isDirectory()) throw new Error('Workspace path has the wrong type')
  if ((details.mode & 0o077) !== 0) throw new Error('Private workspace permissions are too broad')
}

export interface ValidatedInputs {
  readonly workspaceRoot: string
  readonly source: EvaluationSource
  readonly corpus: RepresentativeCorpus
  readonly annotations: GoldAnnotations
  readonly context: BenchmarkContext
  readonly sourceSha256: string
  readonly corpusSha256: string
}

export async function validateWorkspaceInputs(options: {
  workspaceRoot: string
  repositoryRoot: string
  sourcePath: string
  corpusPath: string
  annotationsPath: string
  contextPath: string
  datasetClass: 'private_representative' | 'synthetic_operational'
}): Promise<ValidatedInputs> {
  const workspaceRoot = await realpath(options.workspaceRoot)
  const repositoryRoot = await realpath(options.repositoryRoot)
  if (contains(workspaceRoot, repositoryRoot) || contains(repositoryRoot, workspaceRoot)) {
    throw new Error('Workspace and Git repository must not overlap')
  }
  const { stdout } = await execFile('findmnt', ['-n', '-o', 'FSTYPE', '-T', workspaceRoot])
  if (stdout.trim() !== 'ext4') throw new Error('Benchmark workspace must use external ext4')
  await requirePrivateMode(workspaceRoot, true)

  const paths = [
    options.sourcePath,
    options.corpusPath,
    options.annotationsPath,
    options.contextPath,
  ]
  const canonicalPaths: string[] = []
  for (const inputPath of paths) {
    const canonical = await realpath(inputPath)
    if (options.datasetClass === 'private_representative') {
      if (!contains(workspaceRoot, canonical))
        throw new Error('Private input escapes the workspace')
      await requirePrivateMode(canonical, false)
    }
    canonicalPaths.push(canonical)
  }

  const values = await Promise.all(
    canonicalPaths.map(async (path) => JSON.parse(await readFile(path, 'utf8')) as unknown),
  )
  const governance = validateEvaluationGovernance(values[0], values[1], values[2])
  const context = benchmarkContextSchema.parse(values[3])
  const sourceSha256 = governance.sourceHash
  const corpusSha256 = governance.corpusHash
  if (context.source_sha256 !== sourceSha256 || context.corpus_sha256 !== corpusSha256) {
    throw new Error('Benchmark context identity does not match source and corpus')
  }

  if (options.datasetClass === 'private_representative') {
    if (
      governance.source.provenance.redistribution !== 'workspace_only' ||
      governance.corpus.storage_class !== 'workspace_private' ||
      governance.source.provenance.origin === 'project_synthetic' ||
      context.governance.redistribution !== 'workspace_only'
    ) {
      throw new Error('Representative inputs must be private workspace material')
    }
  } else if (
    governance.source.provenance.origin !== 'project_synthetic' ||
    governance.corpus.storage_class !== 'committed_synthetic'
  ) {
    throw new Error('Synthetic smoke accepts only the committed synthetic governance class')
  }

  const characterIds = context.characters.map((character) => character.character_id)
  if (new Set(characterIds).size !== characterIds.length) {
    throw new Error('Character roster IDs must be unique')
  }
  const allowedIds = new Set([...characterIds, context.narrator_id, context.fallback_dialogue_id])
  for (const annotation of governance.annotations.cases) {
    for (const characterId of annotation.speaker.accepted_character_ids) {
      if (!allowedIds.has(characterId)) throw new Error('Gold character ID is absent from roster')
    }
  }

  return {
    workspaceRoot,
    source: governance.source,
    corpus: governance.corpus,
    annotations: governance.annotations,
    context,
    sourceSha256,
    corpusSha256,
  }
}

export function inputIdentity(inputs: ValidatedInputs): string {
  return canonicalSha256({
    source: inputs.sourceSha256,
    corpus: inputs.corpusSha256,
    context: canonicalSha256(inputs.context),
  })
}
