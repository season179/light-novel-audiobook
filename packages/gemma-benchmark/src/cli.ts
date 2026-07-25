import { execFile as execFileCallback } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { runExactlyThree } from './orchestrator.js'
import { enforceFallbackOrder, profileById } from './profiles.js'
import { withPinnedRuntime } from './runtime.js'
import { fallbackHistorySchema } from './schemas.js'
import { syntheticOperationalStatus } from './status.js'
import { validateWorkspaceInputs } from './workspace.js'

const execFile = promisify(execFileCallback)

function argumentsMap(values: readonly string[]): Map<string, string> {
  const normalized = values[0] === '--' ? values.slice(1) : values
  const result = new Map<string, string>()
  for (let index = 0; index < normalized.length; index += 2) {
    const key = normalized[index]
    const value = normalized[index + 1]
    if (!key?.startsWith('--') || !value || value.startsWith('--') || result.has(key)) {
      throw new Error('Invalid arguments')
    }
    result.set(key, value)
  }
  return result
}

function required(args: Map<string, string>, key: string): string {
  const value = args.get(key)
  if (!value) throw new Error('Missing required argument')
  return resolve(value)
}

async function main(): Promise<void> {
  const args = argumentsMap(process.argv.slice(2))
  const allowed = new Set([
    '--workspace',
    '--experiment-id',
    '--source',
    '--corpus',
    '--annotations',
    '--context',
    '--dataset-class',
    '--runtime-root',
    '--profile',
    '--fallback-history',
    '--port',
  ])
  if ([...args.keys()].some((key) => !allowed.has(key))) throw new Error('Unknown argument')
  const datasetClass = args.get('--dataset-class')
  if (datasetClass !== 'private_representative' && datasetClass !== 'synthetic_operational') {
    throw new Error('A valid dataset class is required')
  }
  const experimentId = args.get('--experiment-id')
  if (!experimentId) throw new Error('Experiment ID is required')
  const profile = profileById(args.get('--profile') ?? 'google-gemma-4-26b-a4b-it-qat-q4-0')
  const historyPath = args.get('--fallback-history')
  const history = historyPath
    ? fallbackHistorySchema.parse(JSON.parse(await readFile(resolve(historyPath), 'utf8')))
    : undefined
  enforceFallbackOrder(profile, history)

  const [{ stdout: repositoryOutput }, { stdout: gitDirectoryOutput }] = await Promise.all([
    execFile('git', ['rev-parse', '--show-toplevel']),
    execFile('git', ['rev-parse', '--absolute-git-dir']),
  ])
  const repositoryRoot = repositoryOutput.trim()
  const gitDirectory = gitDirectoryOutput.trim()
  const inputs = await validateWorkspaceInputs({
    workspaceRoot: required(args, '--workspace'),
    repositoryRoot,
    sourcePath: required(args, '--source'),
    corpusPath: required(args, '--corpus'),
    annotationsPath: required(args, '--annotations'),
    contextPath: required(args, '--context'),
    datasetClass,
  })
  const portValue = Number(args.get('--port') ?? '18086')
  if (!Number.isInteger(portValue) || portValue < 1024 || portValue > 65535) {
    throw new Error('Benchmark port must be an unprivileged integer')
  }
  const runtimeRoot = resolve(
    args.get('--runtime-root') ??
      `${process.env.XDG_CACHE_HOME ?? resolve(homedir(), '.cache')}/light-novel-audiobook/issue-6-brain`,
  )

  const result = await withPinnedRuntime({
    runtimeRoot,
    repositoryRoot,
    gitDirectory,
    profile,
    port: portValue,
    run: async (gateway, runtime) =>
      await runExactlyThree({
        experimentId,
        datasetClass,
        inputs,
        profile,
        runtime,
        gateway,
      }),
  })
  if (datasetClass === 'synthetic_operational') {
    process.stdout.write(`${syntheticOperationalStatus(result.value.operationalPassed)}\n`)
    if (!result.value.operationalPassed) process.exitCode = 1
  } else {
    process.stdout.write(`${result.value.overallPassed ? 'PASS' : 'FAIL'}\n`)
    if (!result.value.overallPassed) process.exitCode = 1
  }
}

try {
  await main()
} catch {
  process.stderr.write('Gemma benchmark failed. Private paths and content were suppressed.\n')
  process.exitCode = 2
}
