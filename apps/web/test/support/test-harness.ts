import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AudiobookClient } from '../../src/client/audiobook-client.js'
import type { AudiobookWebApi } from '../../src/server/audiobook-web-api.js'
import { createAudiobookWebApi } from '../../src/server/composition-root.js'
import { toWebApiResult } from '../../src/server/errors.js'
import { FakeDirectorModel } from '../../src/server/fakes/fake-director-model.js'
import { FakeSpeechEngine } from '../../src/server/fakes/fake-speech-engine.js'
import type { JobStateView } from '../../src/server/job-state-view.js'
import { createM1VoiceCast } from '../../src/server/m1-voice-cast.js'
import { createWorkspace, type LocalWorkspace } from '../../src/server/workspace.js'

/** Blocks the fake speech engine at a chosen segment so a test can observe mid-generation state. */
export class RenderGate {
  private readonly blockAt: number
  private release: (() => void) | undefined
  private seen = 0

  constructor(blockAt: number) {
    this.blockAt = blockAt
  }

  readonly beforeRender = async (): Promise<void> => {
    this.seen += 1
    if (this.seen !== this.blockAt) return
    await new Promise<void>((resolve) => {
      this.release = resolve
    })
  }

  open(): void {
    this.release?.()
  }
}

export interface TestHarness {
  readonly api: AudiobookWebApi
  readonly workspace: LocalWorkspace
  /** The shared fake engine, so a test can count renders across runs. */
  readonly speechEngine: FakeSpeechEngine
  /** Every director the composition root built, newest last. One per generation run. */
  readonly directors: readonly FakeDirectorModel[]
  readonly client: AudiobookClient
  dispose(): Promise<void>
}

export interface TestHarnessOptions {
  readonly beforeRender?: ((segmentId: string) => Promise<void>) | undefined
  /** Defaults to the composition root's M1 stand-in; set `'reject'` to test the real contract. */
  readonly unreviewedFallbackPolicy?: 'reject' | 'auto-approve' | undefined
}

export const createTestHarness = async (options: TestHarnessOptions = {}): Promise<TestHarness> => {
  const root = await mkdtemp(join(tmpdir(), 'lna-web-'))
  const workspace = await createWorkspace(root)
  const voices = createM1VoiceCast()
  // A shared speech engine is the legitimate factory shape for an adapter whose endBatch is not
  // terminal, and it lets a test count renders across two runs. The fallback policy mirrors what the
  // composition root passes: the fake refuses unapproved fallback speech like the real Qwen adapter,
  // so the M1 stand-in has to be explicit here too.
  const speechEngine = new FakeSpeechEngine(workspace, {
    beforeRender: options.beforeRender,
    fallbackVoiceProfileId: voices.fallback.id,
    unreviewedFallbackPolicy: options.unreviewedFallbackPolicy ?? 'auto-approve',
  })
  const directors: FakeDirectorModel[] = []

  const api = await createAudiobookWebApi({
    workspace,
    voices,
    createSpeechEngine: () => speechEngine,
    createDirectorModel: () => {
      const director = new FakeDirectorModel()
      directors.push(director)
      return director
    },
  })

  return {
    api,
    workspace,
    speechEngine,
    directors,
    client: createInProcessClient(api),
    dispose: () => rm(root, { recursive: true, force: true }),
  }
}

/**
 * Calls the same API the server functions call, and normalizes failures exactly the same way, so a
 * component test sees the contract the browser sees.
 */
export const createInProcessClient = (api: AudiobookWebApi): AudiobookClient => ({
  uploadEpub: ({ file }) =>
    toWebApiResult('uploadEpub', async () =>
      api.uploadEpub({ fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }),
    ),
  startGeneration: (input) => toWebApiResult('startGeneration', () => api.startGeneration(input)),
  getJobState: (input) => toWebApiResult('getJobState', () => api.getJobState(input)),
  listChapterAudio: (input) =>
    toWebApiResult('listChapterAudio', () => api.listChapterAudio(input)),
  listUploads: () => toWebApiResult('listUploads', () => api.listUploads()),
})

export const waitForJobState = async (
  api: AudiobookWebApi,
  jobId: string,
  predicate: (job: JobStateView) => boolean,
  timeoutMs = 10_000,
): Promise<JobStateView> => {
  const deadline = Date.now() + timeoutMs
  let latest: JobStateView | null = null
  while (Date.now() < deadline) {
    latest = await api.getJobState({ jobId })
    if (latest !== null && predicate(latest)) return latest
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(
    `Job ${jobId} never reached the expected state. Last seen: ${JSON.stringify(latest)}`,
  )
}
