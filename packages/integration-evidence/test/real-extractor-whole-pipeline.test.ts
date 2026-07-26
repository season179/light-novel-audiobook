import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { GenerateAudiobook } from '../../application/src/index.js'
import { FfmpegAudioAssembler } from '../../audio-assembly/src/index.js'
import { VoiceCast, VoiceProfile } from '../../domain/src/index.js'
import { DomainEpubExtractor, type StoredEpubIngestion } from '../../epub-ingestion/src/index.js'
import { type DirectorProgressStore, GemmaDirectorModel } from '../../gemma-director/src/index.js'
import { layoutFor, openWorkspace, SqliteJobRepository } from '../../persistence/src/index.js'
import { QwenApplicationSpeechEngine, QwenTtsSpeechEngine } from '../../qwen-tts/src/index.js'

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = resolve(TEST_DIRECTORY, '../../..')
const FIXTURE_EPUB = join(REPOSITORY_ROOT, 'tests/fixtures/epub/synthetic-complex.epub')
const FAKE_WORKER = join(REPOSITORY_ROOT, 'packages/qwen-tts/test/fixtures/fake-qwen-process.mjs')
const PRODUCTION_CONFIG = join(REPOSITORY_ROOT, 'config/qwen3-tts-production.json')
const MODEL_LOCK = join(REPOSITORY_ROOT, 'config/qwen3-tts-custom-voice.lock.json')
const UV_LOCK = join(REPOSITORY_ROOT, 'scripts/qwen3-tts-runtime/uv.lock')
const SELECTED_MODEL_ID = 'google-gemma-4-26b-a4b-it-qat-q4-0'
const TEST_TIMEOUT_MS = 180_000
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

function sseChunk(content: string, finishReason: string | null = null): string {
  return JSON.stringify({
    id: 'fake-direction',
    object: 'chat.completion.chunk',
    created: 1,
    model: SELECTED_MODEL_ID,
    choices: [
      {
        index: 0,
        delta: finishReason === null ? { content } : {},
        finish_reason: finishReason,
      },
    ],
  })
}

class RequestResponsiveLlamaServer {
  #server: Server | undefined
  port = 0
  requests = 0

  get baseUrl(): string {
    if (this.port === 0) throw new Error('Fake llama.cpp server is not running')
    return `http://127.0.0.1:${this.port}/v1`
  }

  async start(): Promise<void> {
    this.#server = createServer((request, response) => void this.#handle(request, response))
    await new Promise<void>((resolveStart, rejectStart) => {
      this.#server?.once('error', rejectStart)
      this.#server?.listen(0, '127.0.0.1', resolveStart)
    })
    const address = this.#server.address()
    if (address === null || typeof address === 'string') throw new Error('Missing fake server port')
    this.port = address.port
  }

  async stop(): Promise<void> {
    const server = this.#server
    if (server === undefined) return
    server.closeAllConnections()
    await new Promise<void>((resolveStop, rejectStop) => {
      server.close((error) => (error ? rejectStop(error) : resolveStop()))
    })
    this.#server = undefined
    this.port = 0
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === 'GET' && request.url === '/health') {
      this.#sendJson(response, 200, { status: 'ok' })
      return
    }
    if (request.method === 'GET' && request.url === '/v1/models') {
      this.#sendJson(response, 200, {
        object: 'list',
        data: [{ id: SELECTED_MODEL_ID, object: 'model' }],
      })
      return
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      this.#sendJson(response, 404, { error: { message: 'not found' } })
      return
    }

    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      messages?: readonly { readonly role: string; readonly content: string }[]
    }
    const user = JSON.parse(
      body.messages?.find((message) => message.role === 'user')?.content ?? '{}',
    ) as {
      readonly passages: readonly {
        readonly source_passage_id: string
        readonly source_text: string
      }[]
      readonly narrator_speaker_id: string
    }
    const value = JSON.stringify({
      segments: user.passages.map((passage) => ({
        source_passage_id: passage.source_passage_id,
        source_text: passage.source_text,
        kind: 'narration',
        speaker_id: user.narrator_speaker_id,
        confidence: 0.95,
        delivery: {
          emotion: 'neutral',
          pace: 'normal',
          volume: 'normal',
          pause_after_ms: 250,
        },
        unresolved_speaker: false,
        speaker_reason: null,
      })),
    })
    this.requests += 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const midpoint = Math.max(1, Math.floor(value.length / 2))
    response.write(`data: ${sseChunk(value.slice(0, midpoint))}\n\n`)
    response.write(`data: ${sseChunk(value.slice(midpoint))}\n\n`)
    response.write(`data: ${sseChunk('', 'stop')}\n\n`)
    response.end('data: [DONE]\n\n')
  }

  #sendJson(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(value))
  }
}

function fakeGpuGate(lockFilePath: string) {
  return {
    async acquire(owner: string) {
      return {
        owner,
        lockFilePath,
        quarantine: async () => undefined,
        release: async () => undefined,
      }
    },
  }
}

const progressStore: DirectorProgressStore = { async append() {} }

async function createQwenEngine(root: string, lockFilePath: string): Promise<QwenTtsSpeechEngine> {
  const outputDirectory = join(root, 'audio')
  const snapshotPath = join(root, 'snapshot')
  const workerScriptPath = join(root, 'fake-qwen-process.mjs')
  const runtimeManifestPath = join(root, 'runtime-manifest.json')
  await Promise.all([
    mkdir(outputDirectory, { recursive: true }),
    mkdir(snapshotPath, { recursive: true }),
  ])
  await copyFile(FAKE_WORKER, workerScriptPath)
  await writeFile(
    runtimeManifestPath,
    `${JSON.stringify({
      schemaVersion: 1,
      immutable: true,
      pythonVersion: '3.12.13',
      uvLockSha256: '6a7d989924871b408ed0e6eea86ce21ff399033e1272c5fa19bf9a5e38c3bbd9',
      packages: [
        { name: 'qwen-tts', version: '0.1.1' },
        { name: 'torch', version: '2.9.1' },
        { name: 'torchaudio', version: '2.9.1' },
      ],
    })}\n`,
  )
  return await QwenTtsSpeechEngine.create({
    pythonExecutable: process.execPath,
    workerScriptPath,
    productionConfigPath: PRODUCTION_CONFIG,
    modelLockPath: MODEL_LOCK,
    runtimeManifestPath,
    uvLockPath: UV_LOCK,
    snapshotPath,
    outputDirectory,
    repositoryRoot: REPOSITORY_ROOT,
    gpuGate: fakeGpuGate(lockFilePath) as never,
    processEnvironment: { FAKE_QWEN_MODE: 'normal' },
    cancellationGraceMs: 500,
  })
}

function voices(): VoiceCast {
  const narrator = new VoiceProfile({
    id: 'narrator-aiden',
    displayName: 'Narrator',
    role: 'narrator',
    speakerId: null,
    syntheticSpeaker: 'Aiden',
    instruction:
      'Speak as a calm audiobook narrator with measured pacing, clear diction, and restrained warmth.',
    seed: 9201,
    revision: 1,
  })
  const fallback = new VoiceProfile({
    id: 'fallback-ryan',
    displayName: 'Fallback',
    role: 'fallback',
    speakerId: null,
    syntheticSpeaker: 'Ryan',
    instruction:
      'Speak in a low, weary, restrained manner; tired and guarded, with slow deliberate phrasing and little emotional display.',
    seed: 9205,
    revision: 1,
  })
  return new VoiceCast(narrator, fallback, [])
}

/**
 * Issue #61 regression: all five application adapters and GenerateAudiobook are real; only the
 * llama.cpp/Python transports and GPU locks are fakes. Crucially, this starts from the committed
 * EPUB and lets DomainEpubExtractor decide its declared SVG cover. It never hand-builds a Book or
 * supplies `coverPath: null`, which is the setup mistake that hid the production seam.
 */
describe('whole pipeline with the real extractor cover contract', () => {
  it(
    'degrades the fixture SVG cover before rendering and completes the real adapter pipeline',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'real-extractor-pipeline-'))
      temporaryRoots.push(root)
      const ingestionWorkspace = join(root, 'ingestion')
      await mkdir(ingestionWorkspace)
      const layout = layoutFor(join(root, 'application'))
      const db = openWorkspace(layout)
      const jobs = new SqliteJobRepository(layout, db)
      const brain = new RequestResponsiveLlamaServer()
      await brain.start()
      const gpuLockPath = join(root, 'fake-gpu.lock')

      try {
        const director = new GemmaDirectorModel({
          baseUrl: brain.baseUrl,
          apiKey: 'pipeline-test-server-key-00000001',
          confidenceThreshold: 0.8,
          contextProvider: {
            async forChapter() {
              return {
                speakers: [],
                narratorSpeakerId: 'narrator',
                fallbackSpeakerId: 'fallback',
              }
            },
          },
          progressStore,
          lifecycle: { async start() {}, async release() {} },
          gpuLeaseCoordinator: fakeGpuGate(gpuLockPath) as never,
          gpuLeaseLockFilePath: gpuLockPath,
        })
        const qwen = await createQwenEngine(join(root, 'qwen'), gpuLockPath)
        const useCase = new GenerateAudiobook({
          epubExtractor: new DomainEpubExtractor({
            workspaceRoot: ingestionWorkspace,
            repositoryRoot: REPOSITORY_ROOT,
          }),
          directorModel: director,
          speechEngine: new QwenApplicationSpeechEngine(qwen),
          audioAssembler: await FfmpegAudioAssembler.create(),
          jobs,
        })
        const epubSha256 = createHash('sha256')
          .update(await readFile(FIXTURE_EPUB))
          .digest('hex')

        const result = await useCase.execute({
          jobId: 'real-extractor-cover-contract',
          epubPath: FIXTURE_EPUB,
          epubSha256,
          voices: voices(),
        })

        expect(result.job.state).toBe('completed')
        expect(result.job.stage).toBe('completed')
        expect(result.generatedSegments).toBe(15)
        expect(result.output.m4bPath).toMatch(/\.m4b$/u)
        expect(brain.requests).toBe(5)

        const manifest = JSON.parse(
          await readFile(
            join(ingestionWorkspace, 'books', result.job.bookId ?? '', 'book.json'),
            'utf8',
          ),
        ) as StoredEpubIngestion
        expect(manifest.cover).toBeNull()
        expect(manifest.audit.findings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: 'unusable-cover',
              locators: ['EPUB/images/lantern.svg'],
              detail: expect.stringContaining('image/svg+xml'),
            }),
          ]),
        )
      } finally {
        await brain.stop()
        db.close()
      }
    },
    TEST_TIMEOUT_MS,
  )
})
