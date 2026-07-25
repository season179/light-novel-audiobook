import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AudiobookClient } from '../../src/client/audiobook-client.js'
import type { AudiobookWebApi } from '../../src/server/audiobook-web-api.js'
import { createAudiobookWebApi } from '../../src/server/composition-root.js'
import { FakeSpeechEngine } from '../../src/server/fakes/fake-speech-engine.js'
import type { JobStateView } from '../../src/server/job-state-view.js'
import { createWorkspace, type LocalWorkspace } from '../../src/server/workspace.js'

/** Blocks the fake speech engine at a chosen segment so a test can observe mid-generation state. */
export class RenderGate {
  private readonly blockAt: number
  private release: (() => void) | undefined
  private blocked: Promise<void> | undefined
  private seen = 0

  constructor(blockAt: number) {
    this.blockAt = blockAt
  }

  readonly beforeRender = async (): Promise<void> => {
    this.seen += 1
    if (this.seen !== this.blockAt) return
    this.blocked = new Promise<void>((resolve) => {
      this.release = resolve
    })
    await this.blocked
  }

  open(): void {
    this.release?.()
  }
}

export interface TestHarness {
  readonly api: AudiobookWebApi
  readonly workspace: LocalWorkspace
  readonly speechEngine: FakeSpeechEngine
  readonly client: AudiobookClient
  dispose(): Promise<void>
}

export interface TestHarnessOptions {
  readonly beforeRender?: ((segmentId: string) => Promise<void>) | undefined
}

export const createTestHarness = async (options: TestHarnessOptions = {}): Promise<TestHarness> => {
  const root = await mkdtemp(join(tmpdir(), 'lna-web-'))
  const workspace = await createWorkspace(root)
  const speechEngine = new FakeSpeechEngine(workspace, { beforeRender: options.beforeRender })
  const api = await createAudiobookWebApi({ workspace, speechEngine })

  return {
    api,
    workspace,
    speechEngine,
    client: createInProcessClient(api),
    dispose: () => rm(root, { recursive: true, force: true }),
  }
}

/** Calls the same API the server functions call, without the HTTP transport. */
export const createInProcessClient = (api: AudiobookWebApi): AudiobookClient => ({
  uploadEpub: async ({ file }) =>
    api.uploadEpub({ fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }),
  startGeneration: (input) => api.startGeneration(input),
  getJobState: (input) => api.getJobState(input),
  listChapterAudio: (input) => api.listChapterAudio(input),
  listUploads: () => api.listUploads(),
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
