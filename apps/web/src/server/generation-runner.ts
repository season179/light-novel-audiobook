import type {
  GenerateAudiobook,
  GenerateAudiobookCommand,
} from '@light-novel-audiobook/application'

/**
 * Builds a use case for exactly one run, with adapters that have not been used yet.
 *
 * This is a factory rather than a retained instance for a concrete reason: `GenerateAudiobook`
 * always calls `DirectorModel.release()` when direction finishes, and a real director's release is
 * terminal — `GemmaDirectorModel.release()` memoises its shutdown and every later `directChapter()`
 * throws `Gemma Director has been released`. A process-wide use case would therefore succeed for the
 * first book and fail every later one before direction even started.
 */
export type GenerateAudiobookFactory = () => Promise<GenerateAudiobook>

export type GenerationRunStatus = 'idle' | 'queued' | 'running'

/**
 * Runs generation outside the request that asked for it, one run at a time.
 *
 * Serialization is deliberate: with real adapters a run holds a GPU-bound director and speech
 * engine, and two concurrent runs would put two models on one 16 GB card — exactly what
 * `packages/gpu-lease` exists to prevent. Progress is not held here; the use case persists it
 * through `JobRepository` and the read API always answers from that stored state.
 */
export class GenerationRunner {
  private readonly createGenerate: GenerateAudiobookFactory
  private readonly statuses = new Map<string, Exclude<GenerationRunStatus, 'idle'>>()
  private readonly runs = new Map<string, Promise<void>>()
  private readonly failures = new Map<string, string>()
  private tail: Promise<void> = Promise.resolve()

  constructor(createGenerate: GenerateAudiobookFactory) {
    this.createGenerate = createGenerate
  }

  status(jobId: string): GenerationRunStatus {
    return this.statuses.get(jobId) ?? 'idle'
  }

  isActive(jobId: string): boolean {
    return this.statuses.has(jobId)
  }

  /**
   * The last rejection from a run of this job. A failure the use case could persist is already in
   * the stored job, so this is only consulted when the repository has no job at all — for example
   * adapter construction failing, or generation inputs rejected before the job was created.
   */
  startupFailure(jobId: string): string | undefined {
    return this.failures.get(jobId)
  }

  start(command: GenerateAudiobookCommand): void {
    if (this.statuses.has(command.jobId)) return
    this.failures.delete(command.jobId)
    this.statuses.set(command.jobId, 'queued')

    // Chained onto the tail so runs never overlap, and never rejecting so one failure cannot break
    // the chain for every job behind it.
    const run = this.tail.then(async () => {
      this.statuses.set(command.jobId, 'running')
      try {
        const generate = await this.createGenerate()
        await generate.execute(command)
      } catch (error: unknown) {
        this.failures.set(command.jobId, error instanceof Error ? error.message : String(error))
      } finally {
        this.statuses.delete(command.jobId)
      }
    })
    this.tail = run
    this.runs.set(
      command.jobId,
      run.finally(() => {
        this.runs.delete(command.jobId)
      }),
    )
  }

  /** Resolves once this job's run is no longer in flight. */
  async settled(jobId: string): Promise<void> {
    await this.runs.get(jobId)
  }

  /** Resolves once nothing is queued or running. */
  async idle(): Promise<void> {
    await this.tail
  }
}
