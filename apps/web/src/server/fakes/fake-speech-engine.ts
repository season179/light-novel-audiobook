import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  CompletedSegmentAudio,
  SpeechEngine,
  SpeechRenderRequest,
} from '@light-novel-audiobook/application'
import type { LocalWorkspace } from '../workspace.js'
import { createPlaceholderWav } from './placeholder-wav.js'

export interface FakeSpeechEngineOptions {
  /** Test seam: lets a test hold a render open to observe mid-generation state. */
  readonly beforeRender?: ((segmentId: string) => Promise<void>) | undefined
}

/**
 * FAKE speech engine. It writes tiny placeholder WAVs into the workspace, needs no GPU and no
 * model, and enforces the same batch contract the real Qwen adapter does: no second open batch, no
 * render outside a batch, no overlapping renders, and the segment's voice assignment must match the
 * voice it was handed. `endBatch()` is deliberately *not* terminal — the real adapter clears its
 * batch and accepts a later `beginBatch()`, so this instance stays reusable too. Issue #31 replaces it.
 */
export class FakeSpeechEngine implements SpeechEngine {
  readonly identity = 'fake-speech-engine/1'
  private readonly workspace: LocalWorkspace
  private readonly beforeRender: ((segmentId: string) => Promise<void>) | undefined
  private batchOpen = false
  private rendering = false
  private renderedCount = 0

  constructor(workspace: LocalWorkspace, options: FakeSpeechEngineOptions = {}) {
    this.workspace = workspace
    this.beforeRender = options.beforeRender
  }

  get rendered(): number {
    return this.renderedCount
  }

  async beginBatch(): Promise<void> {
    if (this.batchOpen) throw new Error('Fake speech engine batch is already open')
    this.batchOpen = true
  }

  async render(request: SpeechRenderRequest): Promise<CompletedSegmentAudio> {
    if (!this.batchOpen) throw new Error('Fake speech engine rendered outside a batch')
    if (this.rendering) throw new Error('Fake speech engine renders must remain ordered and serial')
    const assignment = request.segment.voiceAssignment
    if (assignment === null || assignment.voiceProfileId !== request.voice.id) {
      throw new Error(`Fake speech engine voice assignment mismatch for ${request.segment.id}`)
    }
    if (assignment.usesFallback !== (request.voice.role === 'fallback')) {
      throw new Error(`Fake speech engine fallback role mismatch for ${request.segment.id}`)
    }

    this.rendering = true
    try {
      await this.beforeRender?.(request.segment.id)

      const bytes = createPlaceholderWav(
        `${request.segment.id}:${request.voice.renderIdentity}`,
        request.segment.sourceText.length,
      )
      const wavPath = join(this.workspace.segmentsDir, `${request.segment.id}.wav`)
      await mkdir(this.workspace.segmentsDir, { recursive: true })
      await writeFile(wavPath, bytes)
      this.renderedCount += 1

      return {
        segmentId: request.segment.id,
        inputIdentity: request.inputIdentity,
        wavPath,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        byteLength: bytes.byteLength,
      }
    } finally {
      this.rendering = false
    }
  }

  async endBatch(): Promise<void> {
    this.batchOpen = false
  }
}
