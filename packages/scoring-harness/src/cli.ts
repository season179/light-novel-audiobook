import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { canonicalJson, type JsonValue } from './canonical-json.js'
import { RepresentativeCorpusScorer } from './scorer.js'

interface Arguments {
  source: string
  corpus: string
  annotations: string
  runs: [string, string, string]
  output: string
}

function usage(): never {
  throw new Error(
    'Usage: score --source <json> --corpus <json> --annotations <json> --runs <run1> <run2> <run3> --output <report.json>',
  )
}

function parseArguments(values: readonly string[]): Arguments {
  const normalizedValues = values[0] === '--' ? values.slice(1) : values
  const options = new Map<string, string[]>()
  for (let index = 0; index < normalizedValues.length; index += 1) {
    const value = normalizedValues[index]
    if (!value?.startsWith('--')) usage()
    const count = value === '--runs' ? 3 : 1
    const optionValues = normalizedValues.slice(index + 1, index + 1 + count)
    if (optionValues.length !== count || optionValues.some((item) => item.startsWith('--'))) usage()
    if (options.has(value)) usage()
    options.set(value, optionValues)
    index += count
  }
  const source = options.get('--source')?.[0]
  const corpus = options.get('--corpus')?.[0]
  const annotations = options.get('--annotations')?.[0]
  const runs = options.get('--runs')
  const output = options.get('--output')?.[0]
  if (!source || !corpus || !annotations || !runs || runs.length !== 3 || !output) usage()
  if (options.size !== 5) usage()
  return {
    source,
    corpus,
    annotations,
    runs: [runs[0] as string, runs[1] as string, runs[2] as string],
    output,
  }
}

const invocationDirectory = process.env.INIT_CWD ?? process.cwd()

function invocationPath(path: string): string {
  return resolve(invocationDirectory, path)
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(invocationPath(path), 'utf8')) as unknown
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2))
  const [source, corpus, annotations, ...runs] = await Promise.all([
    readJson(args.source),
    readJson(args.corpus),
    readJson(args.annotations),
    ...args.runs.map(readJson),
  ])
  const report = new RepresentativeCorpusScorer().score({ source, corpus, annotations, runs })
  const outputPath = invocationPath(args.output)
  await writeFile(outputPath, `${canonicalJson(report as JsonValue)}\n`, { flag: 'wx' })
  process.stdout.write(`${report.overall_passed ? 'PASS' : 'FAIL'} ${outputPath}\n`)
  if (!report.overall_passed) process.exitCode = 1
}

await main()
