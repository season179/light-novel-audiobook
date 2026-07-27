import type { GenerationRunner } from './generation-runner.js'

export interface RuntimeShutdownOptions {
  /** Shared by every cancellable model operation in this server process. */
  readonly controller?: AbortController | undefined
  /** Reaps owned model processes. Real mode supplies `PipelineTransports.close`. */
  readonly releaseOwnedResources?: (() => Promise<void>) | undefined
  /** Closes process-lifetime persistence only after active jobs have reached a resting state. */
  readonly closeResources?: (() => void | Promise<void>) | undefined
  /** Test seam. Production requests exactly one normal process exit. */
  readonly exit?: ((code: number) => void) | undefined
  /** Test seam for proving that exit is scheduled only after the HTTP response exists. */
  readonly scheduleExit?: ((callback: () => void) => void) | undefined
}

const defaultExit = (code: number): void => {
  process.exit(code)
}

const defaultScheduleExit = (callback: () => void): void => {
  const timer = setTimeout(callback, 150)
  timer.unref()
}

/**
 * One-shot process shutdown. Cancellation first makes an active job persist a resumable resting
 * state; the existing transport close then reaps every owned model process. The HTTP route schedules
 * process exit separately, after it has constructed the acknowledgement response.
 */
export class ShutdownController {
  readonly signal: AbortSignal
  private readonly controller: AbortController
  private readonly runner: GenerationRunner
  private readonly releaseOwnedResources: () => Promise<void>
  private readonly closeResources: () => void | Promise<void>
  private readonly exit: (code: number) => void
  private readonly schedule: (callback: () => void) => void
  private preparePromise: Promise<void> | undefined
  private exitScheduled = false

  constructor(runner: GenerationRunner, options: RuntimeShutdownOptions = {}) {
    this.runner = runner
    this.controller = options.controller ?? new AbortController()
    this.signal = this.controller.signal
    this.releaseOwnedResources = options.releaseOwnedResources ?? (async () => undefined)
    this.closeResources = options.closeResources ?? (() => undefined)
    this.exit = options.exit ?? defaultExit
    this.schedule = options.scheduleExit ?? defaultScheduleExit
  }

  /** Releases resources and leaves active work resumable; safe to call more than once. */
  prepare(): Promise<void> {
    this.preparePromise ??= this.prepareOnce()
    return this.preparePromise
  }

  private async prepareOnce(): Promise<void> {
    this.runner.beginShutdown()
    this.controller.abort(new Error('The local server is stopping'))
    const results = await Promise.allSettled([this.runner.idle(), this.releaseOwnedResources()])
    await this.closeResources()
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason)
    if (failures.length > 0) {
      throw new AggregateError(failures, 'The local server could not release every owned resource')
    }
  }

  /** Called only after the stop route has built the response the browser will consume. */
  exitAfterResponse(): void {
    if (this.exitScheduled) return
    this.exitScheduled = true
    this.schedule(() => this.exit(0))
  }
}
