import { beforeEach, describe, expect, it, vi } from 'vitest'

const serverFns = vi.hoisted(() => ({
  approveAllFallbacksFn: vi.fn(),
  approveFallbackFn: vi.fn(),
  getJobStateFn: vi.fn(),
  listChapterAudioFn: vi.fn(),
  listFallbackReviewFn: vi.fn(),
  listUploadsFn: vi.fn(),
  renderApprovedScriptFn: vi.fn(),
  revokeFallbackFn: vi.fn(),
  startGenerationFn: vi.fn(),
  uploadEpubFn: vi.fn(),
}))

vi.mock('../src/api/audiobook-server-fns.js', () => serverFns)

import { serverFnAudiobookClient } from '../src/client/server-fn-audiobook-client.js'

describe('production server-function audiobook client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('forwards every slice bound in the outgoing start-generation payload', async () => {
    const command = {
      uploadId: 'upload-transport-probe',
      recoverAbandoned: false,
      slice: {
        firstChapter: 2,
        maxChapters: 3,
        maxPassagesPerChapter: 4,
      },
    }

    await serverFnAudiobookClient.startGeneration(command)

    expect(serverFns.startGenerationFn).toHaveBeenCalledOnce()
    expect(serverFns.startGenerationFn).toHaveBeenCalledWith({ data: command })
  })
})
