import type {
  GenerateAudiobook,
  GenerateAudiobookCommand,
} from '@light-novel-audiobook/application'

/**
 * Runs `GenerateAudiobook` outside the request that asked for it, so generation never depends on a
 * web-request lifetime. Progress is not held here: the use case persists it through `JobRepository`
 * and the read API always answers from that stored state.
 *
 * Issue #21 can replace this with the real background worker without changing the web API.
 */
export class GenerationRunner {
  private readonly generate: GenerateAudiobook
  private readonly active = new Map<string, Promise<void>>()
  private readonly startupFailures = new Map<string, string>()

  constructor(generate: GenerateAudiobook) {
    this.generate = generate
  }

  isActive(jobId: string): boolean {
    return this.active.has(jobId)
  }

  /**
   * The last rejection from a run of this job. A failure the use case could persist is already in
   * the stored job, so this is only consulted when the repository has no job at all — for example
   * generation inputs rejected before the job was created. Without it the browser would poll a job
   * that never appears.
   */
  startupFailure(jobId: string): string | undefined {
    return this.startupFailures.get(jobId)
  }

  start(command: GenerateAudiobookCommand): void {
    if (this.active.has(command.jobId)) return
    this.startupFailures.delete(command.jobId)

    const run = this.generate
      .execute(command)
      .then(() => undefined)
      .catch((error: unknown) => {
        this.startupFailures.set(
          command.jobId,
          error instanceof Error ? error.message : String(error),
        )
      })
      .finally(() => {
        this.active.delete(command.jobId)
      })

    this.active.set(command.jobId, run)
  }

  /** Test and shutdown helper: resolves once the run for this job is no longer in flight. */
  async settled(jobId: string): Promise<void> {
    await this.active.get(jobId)
  }
}
