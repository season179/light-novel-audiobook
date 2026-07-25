import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import {
  type DirectorProgressEvent,
  type DirectorProgressStore,
  GemmaDirectorModel,
  SELECTED_GEMMA_PROFILE,
} from '../src/index.js'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_CONFIG = resolve(PACKAGE_ROOT, 'config/real-smoke.json')
const configSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profileId: z.literal(SELECTED_GEMMA_PROFILE.id),
  baseUrl: z.string().url(),
  runtimeRoot: z.string().min(1),
  timeoutMs: z.int().min(1).max(3_600_000),
})
const hostManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  llamaCommit: z.literal('555881ebc8b0fc0402b30e09258a32a7bfd13c52'),
  binarySha256: z.string().regex(/^[a-f0-9]{64}$/),
  modelRevision: z.literal(SELECTED_GEMMA_PROFILE.revision),
  modelSha256: z.literal(SELECTED_GEMMA_PROFILE.sha256),
  modelSizeBytes: z.literal(SELECTED_GEMMA_PROFILE.sizeBytes),
  cudaCompiler: z.string().min(1),
  cmakeConfigurationSha256: z.string().regex(/^[a-f0-9]{64}$/),
  cleanSourceCheckout: z.literal(true),
  cleanRebuild: z.literal(true),
  textModelOnly: z.literal(true),
})

class SanitizedProgressStore implements DirectorProgressStore {
  readonly states: string[] = []

  async append(event: DirectorProgressEvent): Promise<void> {
    this.states.push(event.state)
  }
}

function configPath(): string {
  const args = process.argv.slice(2)
  if (args.length === 0) return DEFAULT_CONFIG
  if (args.length === 2 && args[0] === '--config' && args[1]) return resolve(args[1])
  throw new Error('Usage: smoke:real [--config <sanitized-config.json>]')
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2))
  return resolve(path)
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function main(): Promise<void> {
  if (process.env.GEMMA_DIRECTOR_REAL_SMOKE !== '1') {
    throw new Error('Real Gemma inference is opt-in; set GEMMA_DIRECTOR_REAL_SMOKE=1')
  }
  const apiKey = process.env.GEMMA_DIRECTOR_API_KEY
  if (!apiKey) throw new Error('Set GEMMA_DIRECTOR_API_KEY for the already-running local server')

  const config = configSchema.parse(JSON.parse(await readFile(configPath(), 'utf8')))
  const runtimeRoot = expandHome(process.env.GEMMA_DIRECTOR_RUNTIME_ROOT ?? config.runtimeRoot)
  const manifest = hostManifestSchema.parse(
    JSON.parse(await readFile(resolve(runtimeRoot, 'host-build.json'), 'utf8')),
  )
  const modelPath = resolve(runtimeRoot, 'models', SELECTED_GEMMA_PROFILE.file)
  const binaryPath = resolve(runtimeRoot, 'llama.cpp/build/bin/llama-server')
  const [modelStat, binaryStat, modelSha256, binarySha256] = await Promise.all([
    stat(modelPath),
    stat(binaryPath),
    sha256File(modelPath),
    sha256File(binaryPath),
  ])
  if (!modelStat.isFile() || modelStat.size !== SELECTED_GEMMA_PROFILE.sizeBytes) {
    throw new Error('Installed local Gemma file does not match the selected profile size')
  }
  if (modelSha256 !== SELECTED_GEMMA_PROFILE.sha256) {
    throw new Error('Installed local Gemma hash does not match the selected profile')
  }
  if (!binaryStat.isFile() || (binaryStat.mode & 0o111) === 0) {
    throw new Error('Installed selected-profile llama-server is missing or not executable')
  }
  if (binarySha256 !== manifest.binarySha256) {
    throw new Error('Installed llama-server hash does not match its pinned host manifest')
  }

  const progress = new SanitizedProgressStore()
  const model = new GemmaDirectorModel({
    baseUrl: config.baseUrl,
    apiKey,
    progressStore: progress,
  })
  const health = await model.health({ timeoutMs: 5_000 })
  if (health.status !== 'ok' || !health.selectedModelAvailable) {
    throw new Error('Local endpoint does not expose the selected Gemma profile alias')
  }
  const result = await model.direct(
    {
      requestId: 'public-real-smoke-001',
      chapterId: 'public-smoke-chapter',
      passages: [
        { id: 'public-smoke-passage-001', text: 'Rain tapped against the window.' },
        { id: 'public-smoke-passage-002', text: '“I will return before dawn,” Mira said.' },
      ],
      speakers: [{ id: 'mira', aliases: ['Mira'] }],
      narratorSpeakerId: 'narrator',
      fallbackSpeakerId: 'fallback-dialogue',
      storyContext: 'Mira speaks the second supplied passage.',
    },
    { timeoutMs: config.timeoutMs },
  )

  console.log(
    JSON.stringify(
      {
        status: 'passed',
        sanitized: true,
        profileId: result.identity.profileId,
        modelRevision: manifest.modelRevision,
        modelSha256: manifest.modelSha256,
        passageCount: result.segments.length,
        warningCount: result.warnings.length,
        kinds: result.segments.map((segment) => segment.kind),
        speakers: result.segments.map((segment) => segment.speakerId),
        requestSha256: result.requestSha256,
        outputSha256: result.outputSha256,
        progressStates: progress.states,
        sourceTextIncluded: false,
        apiKeyIncluded: false,
        absolutePathsIncluded: false,
      },
      null,
      2,
    ),
  )
}

await main()
