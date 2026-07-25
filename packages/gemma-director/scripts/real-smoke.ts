import { type ChildProcess, execFile as execFileCallback, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, readFile, readlink, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Book, Chapter, SourcePassage } from '@light-novel-audiobook/domain'
import { z } from 'zod'
import {
  assertOwnedLoopbackListener,
  assertOwnedProcessIdentity,
  type DirectorProgressEvent,
  type DirectorProgressStore,
  type DirectorRuntimeLifecycle,
  FileGpuLeaseCoordinator,
  GemmaDirectorEndpoint,
  GemmaDirectorModel,
  probeBrowserBoundary,
  SELECTED_GEMMA_PROFILE,
} from '../src/index.js'

const execFile = promisify(execFileCallback)
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_CONFIG = resolve(PACKAGE_ROOT, 'config/real-smoke.json')
const configSchema = z.strictObject({
  schemaVersion: z.literal(2),
  profileId: z.literal(SELECTED_GEMMA_PROFILE.id),
  baseUrl: z.string().url(),
  runtimeRoot: z.string().min(1),
  gpuLeasePath: z.string().min(1),
  startupTimeoutMs: z.int().min(1).max(1_800_000),
  requestTimeoutMs: z.int().min(1).max(3_600_000),
  confidenceThreshold: z.number().min(0).max(1),
})
const hostManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  llamaCommit: z.literal(SELECTED_GEMMA_PROFILE.llamaCppCommit),
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

class OwnedLlamaLifecycle implements DirectorRuntimeLifecycle {
  private releasePromise: Promise<void> | undefined
  cleanupComplete = false

  constructor(
    private readonly child: ChildProcess,
    private readonly keyPath: string,
    private readonly port: number,
  ) {}

  release(): Promise<void> {
    if (this.releasePromise !== undefined) return this.releasePromise
    this.releasePromise = this.releaseOnce()
    return this.releasePromise
  }

  private async releaseOnce(): Promise<void> {
    try {
      if (!childExited(this.child)) {
        this.child.kill('SIGTERM')
        if (!(await waitForChildExit(this.child, 15_000))) {
          this.child.kill('SIGKILL')
          if (!(await waitForChildExit(this.child, 10_000))) {
            throw new Error('Owned llama-server did not exit after SIGKILL')
          }
        }
      }
    } finally {
      await rm(this.keyPath, { force: true })
      await waitForPortFree(this.port, 10_000)
    }
    this.cleanupComplete = true
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

function childExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childExited(child)) return true
  return await new Promise<boolean>((resolvePromise) => {
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      resolvePromise(value)
    }
    const onExit = (): void => finish(true)
    const timer = setTimeout(() => finish(childExited(child)), timeoutMs)
    child.once('exit', onExit)
  })
}

async function portIsFree(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise) => {
    const server = createServer()
    server.once('error', () => resolvePromise(false))
    server.listen(port, '127.0.0.1', () => {
      server.close((error) => resolvePromise(error === undefined))
    })
  })
}

async function waitForPortFree(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await portIsFree(port)) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
  }
  throw new Error('Owned llama-server did not release its configured port')
}

async function waitForHealth(options: {
  origin: string
  apiKey: string
  child: ChildProcess
  childError: () => Error | undefined
  timeoutMs: number
}): Promise<void> {
  const deadline = Date.now() + options.timeoutMs
  while (Date.now() < deadline) {
    const emittedError = options.childError()
    if (emittedError) throw new Error('Owned llama-server failed to spawn', { cause: emittedError })
    if (childExited(options.child)) throw new Error('Owned llama-server exited during model load')
    try {
      const response = await fetch(`${options.origin}/health`, {
        headers: { authorization: `Bearer ${options.apiKey}` },
        signal: AbortSignal.timeout(2_000),
      })
      if (response.ok) return
    } catch {
      // Expected while the owned model process is loading.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
  throw new Error('Owned llama-server did not become healthy before the startup deadline')
}

function smokeBook(): Book {
  const chapter = new Chapter({
    id: 'public-smoke-chapter',
    bookId: 'public-smoke-book',
    position: 1,
    title: 'Public Smoke Chapter',
    sourcePassages: [
      new SourcePassage({
        id: 'public-smoke-passage-001',
        chapterId: 'public-smoke-chapter',
        sourceText: 'Rain tapped against the window.',
      }),
      new SourcePassage({
        id: 'public-smoke-passage-002',
        chapterId: 'public-smoke-chapter',
        sourceText: '“I will return before dawn,” Mira said.',
      }),
    ],
  })
  return new Book({
    id: 'public-smoke-book',
    title: 'Public Synthetic Smoke',
    author: null,
    coverPath: null,
    source: { epubPath: '/synthetic/public-smoke.epub', sha256: 'b'.repeat(64) },
    chapters: [chapter],
  })
}

async function main(): Promise<void> {
  if (process.env.GEMMA_DIRECTOR_REAL_SMOKE !== '1') {
    throw new Error('Real Gemma inference is opt-in; set GEMMA_DIRECTOR_REAL_SMOKE=1')
  }

  const config = configSchema.parse(JSON.parse(await readFile(configPath(), 'utf8')))
  const endpoint = new GemmaDirectorEndpoint(config.baseUrl)
  const runtimeRoot = await realpath(
    expandHome(process.env.GEMMA_DIRECTOR_RUNTIME_ROOT ?? config.runtimeRoot),
  )
  const manifest = hostManifestSchema.parse(
    JSON.parse(await readFile(resolve(runtimeRoot, 'host-build.json'), 'utf8')),
  )
  const modelPath = resolve(runtimeRoot, 'models', SELECTED_GEMMA_PROFILE.file)
  const binaryPath = resolve(runtimeRoot, 'llama.cpp/build/bin/llama-server')
  const [modelStat, binaryStat, modelSha256, binarySha256, canonicalBinary] = await Promise.all([
    stat(modelPath),
    stat(binaryPath),
    sha256File(modelPath),
    sha256File(binaryPath),
    realpath(binaryPath),
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
  if (!(await portIsFree(endpoint.port))) {
    throw new Error('Refusing to attest an occupied endpoint not owned by this smoke command')
  }

  const apiKey = randomBytes(32).toString('base64url')
  const keyPath = resolve(runtimeRoot, `.gemma-director-smoke-key-${process.pid}`)
  const gpuLeasePath = expandHome(process.env.GEMMA_DIRECTOR_GPU_LEASE_PATH ?? config.gpuLeasePath)
  const gpuLeaseCoordinator = new FileGpuLeaseCoordinator({ lockFilePath: gpuLeasePath })
  const gpuLease = await gpuLeaseCoordinator.acquire('gemma')
  const args = [
    '--model',
    modelPath,
    '--alias',
    SELECTED_GEMMA_PROFILE.modelId,
    '--host',
    endpoint.host,
    '--port',
    String(endpoint.port),
    '--ctx-size',
    String(SELECTED_GEMMA_PROFILE.contextSize),
    '--parallel',
    '1',
    '--n-gpu-layers',
    String(SELECTED_GEMMA_PROFILE.gpuLayers),
    '--cache-type-k',
    SELECTED_GEMMA_PROFILE.cacheTypeK,
    '--cache-type-v',
    SELECTED_GEMMA_PROFILE.cacheTypeV,
    '--flash-attn',
    'on',
    '--batch-size',
    String(SELECTED_GEMMA_PROFILE.batchSize),
    '--ubatch-size',
    String(SELECTED_GEMMA_PROFILE.microBatchSize),
    '--threads',
    String(SELECTED_GEMMA_PROFILE.threads),
    '--reasoning',
    SELECTED_GEMMA_PROFILE.reasoning,
    '--no-cache-prompt',
    '--api-key-file',
    keyPath,
    '--cors-origins',
    'localhost',
    '--no-cors-credentials',
    '--no-webui',
    '--metrics',
    '--slots',
    '--log-disable',
  ]
  let child: ChildProcess | undefined
  let lifecycle: OwnedLlamaLifecycle | undefined
  let model: GemmaDirectorModel | undefined
  let sanitizedResult: Record<string, unknown> | undefined
  let childError: Error | undefined
  const onChildError = (error: Error): void => {
    childError = error
  }
  try {
    await writeFile(keyPath, `${apiKey}\n`, { flag: 'wx', mode: 0o600 })
    await chmod(keyPath, 0o600)
    child = spawn(canonicalBinary, args, { stdio: ['ignore', 'ignore', 'ignore'] })
    child.on('error', onChildError)
    lifecycle = new OwnedLlamaLifecycle(child, keyPath, endpoint.port)
    const progress = new SanitizedProgressStore()
    model = new GemmaDirectorModel({
      baseUrl: endpoint.baseUrl,
      apiKey,
      confidenceThreshold: config.confidenceThreshold,
      contextProvider: {
        forChapter: async () => ({
          speakers: [{ id: 'mira', aliases: ['Mira'] }],
          narratorSpeakerId: 'narrator',
          fallbackSpeakerId: 'fallback-dialogue',
          storyContext: 'Mira speaks the second supplied passage.',
        }),
      },
      progressStore: progress,
      lifecycle,
      gpuLeaseCoordinator,
      gpuLeaseLockFilePath: gpuLeasePath,
      initialGpuLease: gpuLease,
    })
    await waitForHealth({
      origin: endpoint.origin,
      apiKey,
      child,
      childError: () => childError,
      timeoutMs: config.startupTimeoutMs,
    })
    if (child.pid === undefined) throw new Error('Owned llama-server has no process ID')
    const [observedExecutable, rawCommandLine, listener] = await Promise.all([
      realpath(await readlink(`/proc/${child.pid}/exe`)),
      readFile(`/proc/${child.pid}/cmdline`),
      execFile('ss', ['-H', '-ltnp', `( sport = :${endpoint.port} )`]),
    ])
    const observedArgv = rawCommandLine.toString('utf8').split('\u0000').filter(Boolean)
    assertOwnedProcessIdentity({
      expectedExecutable: canonicalBinary,
      observedExecutable,
      expectedArgv: [canonicalBinary, ...args],
      observedArgv,
    })
    assertOwnedLoopbackListener(listener.stdout, child.pid, endpoint.host, endpoint.port)
    const browserBoundary = await probeBrowserBoundary({
      origin: endpoint.origin,
      apiKey,
      modelId: SELECTED_GEMMA_PROFILE.modelId,
    })
    const health = await model.health({ timeoutMs: 5_000 })
    if (health.status !== 'ok' || !health.selectedModelAvailable) {
      throw new Error('Owned endpoint does not expose the selected Gemma profile alias')
    }
    const book = smokeBook()
    const result = await model.directChapter(book, book.chapters[0] as Chapter, {
      timeoutMs: config.requestTimeoutMs,
    })

    sanitizedResult = {
      status: 'passed',
      sanitized: true,
      ownedEndpoint: true,
      ownedProcessIdVerified: true,
      loopbackListenerVerified: true,
      gpuLeaseProtocolVerified: true,
      profileId: result.modelIdentity.profileId,
      directorIdentity: model.identity,
      modelRevision: manifest.modelRevision,
      modelSha256: manifest.modelSha256,
      binarySha256: manifest.binarySha256,
      fragmentCount: result.segments.length,
      warningCount: result.warnings.length,
      kinds: result.segments.map((segment) => segment.kind),
      speakers: result.segments.map((segment) => segment.speakerId),
      requestSha256: result.requestSha256,
      outputSha256: result.outputSha256,
      browserBoundary,
      progressStates: progress.states,
      sourceTextIncluded: false,
      apiKeyIncluded: false,
      absolutePathsIncluded: false,
    }
  } finally {
    try {
      if (model !== undefined) {
        await model.release()
      } else if (lifecycle !== undefined) {
        await lifecycle.release()
        await gpuLease.release()
      } else {
        await rm(keyPath, { force: true })
        await gpuLease.release()
      }
    } finally {
      child?.removeListener('error', onChildError)
    }
  }
  if (lifecycle?.cleanupComplete !== true) {
    throw new Error('Owned llama-server cleanup was not verified')
  }
  if (sanitizedResult === undefined) throw new Error('Real smoke did not produce a valid result')
  console.log(JSON.stringify({ ...sanitizedResult, cleanupVerified: true }, null, 2))
}

await main()
