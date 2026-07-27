import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DirectChapterOptions } from '@light-novel-audiobook/application'
import type { AudiobookClient } from '../../src/client/audiobook-client.js'
import type { AudiobookWebApi } from '../../src/server/audiobook-web-api.js'
import { createAudiobookComposition } from '../../src/server/composition-root.js'
import { toWebApiResult } from '../../src/server/errors.js'
import { FakeDirectorModel } from '../../src/server/fakes/fake-director-model.js'
import { FakeSpeechEngine } from '../../src/server/fakes/fake-speech-engine.js'
import type { FallbackSelectionReview } from '../../src/server/fallback-selection-review.js'
import type { JobStateView } from '../../src/server/job-state-view.js'
import {
  createM1VoiceCast,
  loadPinnedQwenConfig,
  pinnedVoiceMaterial,
} from '../../src/server/m1-voice-cast.js'
import {
  REVIEWER_ENV_VARIABLE,
  resolveReviewerIdentity,
} from '../../src/server/reviewer-identity.js'
import { createWorkspace, type LocalWorkspace } from '../../src/server/workspace.js'

/** The actor this harness records on decisions it makes on the user's behalf. */
export const TEST_REVIEWER = 'test-reviewer'

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
  /** The exact-set decision path, sharing the composition's review ledgers and runner. */
  readonly selection: FallbackSelectionReview
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
  readonly directorOptions?: DirectChapterOptions | undefined
}

export const createTestHarness = async (options: TestHarnessOptions = {}): Promise<TestHarness> => {
  const root = await mkdtemp(join(tmpdir(), 'lna-web-'))
  const workspace = await createWorkspace(root)
  const pinnedConfig = await loadPinnedQwenConfig()
  const voices = createM1VoiceCast(pinnedConfig)
  // A shared speech engine is the legitimate factory shape for an adapter whose endBatch is not
  // terminal, and it lets a test count renders across two runs. There is deliberately no fallback
  // policy: the fake refuses unapproved fallback speech exactly as the real Qwen adapter does, so a
  // book with unresolved speakers stops for review until a test issues a real approval.
  const speechEngine = new FakeSpeechEngine(workspace, {
    beforeRender: options.beforeRender,
    fallbackVoiceProfileId: voices.fallback.id,
    pinnedVoiceProfiles: pinnedVoiceMaterial(pinnedConfig),
  })
  const directors: FakeDirectorModel[] = []

  const composition = await createAudiobookComposition({
    workspace,
    voices,
    // Supplied through the canonical resolver (explicit configuration, never the OS account), so a
    // test does not depend on the account running it and the branded value still only originates
    // there. This is exactly how #21 will pass a real identity.
    reviewer: resolveReviewerIdentity({ [REVIEWER_ENV_VARIABLE]: TEST_REVIEWER }),
    speechEngineFactory: {
      identity: speechEngine.identity,
      create: (context) => {
        speechEngine.replaceApprovals(context.fallbackApprovals)
        return speechEngine
      },
    },
    directorIdentity: new FakeDirectorModel().identity,
    createDirectorModel: () => {
      const director = new FakeDirectorModel()
      directors.push(director)
      return director
    },
    ...(options.directorOptions === undefined ? {} : { directorOptions: options.directorOptions }),
  })

  return {
    api: composition.api,
    selection: composition.fallbackSelection,
    workspace,
    speechEngine,
    directors,
    client: createInProcessClient(composition),
    dispose: () => rm(root, { recursive: true, force: true }),
  }
}

/**
 * Calls the same API the server functions call, and normalizes failures exactly the same way, so a
 * component test sees the contract the browser sees.
 */
export const createInProcessClient = (composition: {
  readonly api: AudiobookWebApi
  readonly fallbackSelection: FallbackSelectionReview
}): AudiobookClient => {
  const { api, fallbackSelection } = composition
  return {
    uploadEpub: ({ file }) =>
      toWebApiResult('uploadEpub', async () =>
        api.uploadEpub({ fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }),
      ),
    startGeneration: (input) => toWebApiResult('startGeneration', () => api.startGeneration(input)),
    getJobState: (input) => toWebApiResult('getJobState', () => api.getJobState(input)),
    listChapterAudio: (input) =>
      toWebApiResult('listChapterAudio', () => api.listChapterAudio(input)),
    listUploads: () => toWebApiResult('listUploads', () => api.listUploads()),
    listFallbackReview: (input) =>
      toWebApiResult('listFallbackReview', () => api.listFallbackReview(input)),
    approveAllFallbacks: (input) =>
      toWebApiResult('approveAllFallbacks', () => api.approveAllFallbacks(input)),
    approveFallback: (input) => toWebApiResult('approveFallback', () => api.approveFallback(input)),
    // The exact-set decision and the re-listed view, in the same order the server function does them.
    approveSelectedFallbacks: (input) =>
      toWebApiResult('approveSelectedFallbacks', async () => {
        await fallbackSelection.approveSelected(input)
        return api.listFallbackReview({ jobId: input.jobId })
      }),
    revokeFallback: (input) => toWebApiResult('revokeFallback', () => api.revokeFallback(input)),
    renderApprovedScript: (input) =>
      toWebApiResult('renderApprovedScript', () => api.renderApprovedScript(input)),
  }
}

/**
 * Waits for a job state, making the user's fallback-voice decision if the job stops for it.
 *
 * The fixture book contains unresolved speakers, so **every** run now stops at `awaiting_review`
 * until a human decides — there is no policy or default that approves anything. Rather than repeat
 * that dance in twenty tests, this helper performs it through the real
 * `approveAllFallbacks` + `renderApprovedScript` API, so a broken approval path fails the whole
 * suite instead of being papered over. The stop itself, and that nothing renders before the
 * decision, are asserted directly in `fallback-review.test.ts`.
 */
export const waitForJobState = async (
  api: AudiobookWebApi,
  jobId: string,
  predicate: (job: JobStateView) => boolean,
  timeoutMs = 10_000,
): Promise<JobStateView> => {
  const deadline = performance.now() + timeoutMs
  let latest: JobStateView | null = null
  let decided = false
  while (performance.now() < deadline) {
    latest = await api.getJobState({ jobId })
    if (latest !== null && predicate(latest)) return latest
    if (latest?.state === 'awaiting_review' && !decided) {
      decided = true
      await api.approveAllFallbacks({ jobId })
      await api.renderApprovedScript({ jobId })
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(
    `Job ${jobId} never reached the expected state. Last seen: ${JSON.stringify(latest)}`,
  )
}
