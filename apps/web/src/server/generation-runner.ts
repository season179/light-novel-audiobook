import type {
  DirectAudiobook,
  DirectAudiobookCommand,
  RenderAudiobook,
  RenderAudiobookCommand,
} from '@light-novel-audiobook/application'
import { toPublicFailureMessage } from './errors.js'

/** A fresh Stage-A operation; real directors are terminal after release. */
export type DirectAudiobookFactory = (command: DirectAudiobookCommand) => Promise<DirectAudiobook>

/** A fresh Stage-B operation, built without an extractor or director. */
export type RenderAudiobookFactory = (command: RenderAudiobookCommand) => Promise<RenderAudiobook>

export interface GenerationRunnerOperations {
  readonly createDirection: DirectAudiobookFactory
  readonly createRendering: RenderAudiobookFactory
}

export type GenerationRunStatus = 'idle' | 'queued' | 'running'

/**
 * Serializes explicit direction and rendering operations outside web requests.
 *
 * Uploads can enqueue only Stage A. Stage B has its own method and therefore cannot happen merely
 * because direction found no warnings. Both share one queue so Gemma and Qwen never overlap on the
 * same GPU.
 */
export class GenerationRunner {
  private readonly operations: GenerationRunnerOperations
  private readonly statuses = new Map<string, Exclude<GenerationRunStatus, 'idle'>>()
  private readonly runs = new Map<string, Promise<void>>()
  private readonly failures = new Map<string, string>()
  private tail: Promise<void> = Promise.resolve()

  constructor(operations: GenerationRunnerOperations) {
    this.operations = operations
  }

  status(jobId: string): GenerationRunStatus {
    return this.statuses.get(jobId) ?? 'idle'
  }

  isActive(jobId: string): boolean {
    return this.statuses.has(jobId)
  }

  startupFailure(jobId: string): string | undefined {
    return this.failures.get(jobId)
  }

  startDirection(command: DirectAudiobookCommand): void {
    this.start(command.jobId, async () => {
      const direction = await this.operations.createDirection(command)
      await direction.execute(command)
    })
  }

  startRendering(command: RenderAudiobookCommand): void {
    this.start(command.jobId, async () => {
      const rendering = await this.operations.createRendering(command)
      await rendering.execute(command)
    })
  }

  private start(jobId: string, execute: () => Promise<void>): void {
    if (this.statuses.has(jobId)) return
    this.failures.delete(jobId)
    this.statuses.set(jobId, 'queued')

    const run = this.tail.then(async () => {
      this.statuses.set(jobId, 'running')
      try {
        await execute()
      } catch (error: unknown) {
        this.failures.set(jobId, toPublicFailureMessage(error, 'generationRunner.run'))
      } finally {
        this.statuses.delete(jobId)
      }
    })
    this.tail = run
    this.runs.set(
      jobId,
      run.finally(() => {
        this.runs.delete(jobId)
      }),
    )
  }

  async settled(jobId: string): Promise<void> {
    await this.runs.get(jobId)
  }

  async idle(): Promise<void> {
    await this.tail
  }
}
