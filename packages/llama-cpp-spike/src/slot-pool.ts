import { SpikeError } from './errors'

interface Waiter {
  readonly signal: AbortSignal | undefined
  readonly resolve: (release: () => void) => void
  readonly reject: (error: SpikeError) => void
  readonly onAbort: () => void
}

export interface SlotPoolSnapshot {
  readonly capacity: number
  readonly active: number
  readonly queued: number
}

export class SlotPool {
  readonly capacity: number
  private activeCount = 0
  private readonly waiters: Array<Waiter> = []

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error('SlotPool capacity must be a positive integer')
    }
    this.capacity = capacity
  }

  snapshot(): SlotPoolSnapshot {
    return { capacity: this.capacity, active: this.activeCount, queued: this.waiters.length }
  }

  async withSlot<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(signal)
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private acquire(signal: AbortSignal | undefined): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(new SpikeError('cancelled', 'slot acquisition was cancelled'))
    }
    if (this.activeCount < this.capacity) {
      this.activeCount += 1
      return Promise.resolve(this.createRelease())
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter)
          if (index !== -1) this.waiters.splice(index, 1)
          reject(new SpikeError('cancelled', 'queued slot acquisition was cancelled'))
        },
      }
      signal?.addEventListener('abort', waiter.onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  private createRelease(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.activeCount -= 1
      this.dispatch()
    }
  }

  private dispatch(): void {
    while (this.activeCount < this.capacity) {
      const waiter = this.waiters.shift()
      if (!waiter) return
      waiter.signal?.removeEventListener('abort', waiter.onAbort)
      if (waiter.signal?.aborted) {
        waiter.reject(new SpikeError('cancelled', 'queued slot acquisition was cancelled'))
        continue
      }
      this.activeCount += 1
      waiter.resolve(this.createRelease())
    }
  }
}
