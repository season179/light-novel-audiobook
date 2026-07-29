export type KernelLockAcquisition =
  | { readonly kind: 'nonblocking' }
  | { readonly kind: 'bounded'; readonly waitMs: number }

export interface KernelLockAcquireOptions {
  readonly lockFilePath: string
  readonly acquisition: KernelLockAcquisition
  readonly conflictExitCode: number
  readonly signal?: AbortSignal
}

/** The complete provider-neutral contract: ownership exists only for this held lifetime. */
export interface HeldKernelLock {
  readonly protocol: string
  assertHeld(): void
  release(): Promise<void>
}

export interface KernelLockStrategy {
  readonly protocol: string
  acquire(options: KernelLockAcquireOptions): Promise<HeldKernelLock>
}

export type KernelLockErrorCode = 'busy' | 'cancelled' | 'unavailable'

export class KernelLockError extends Error {
  override readonly name = 'KernelLockError'
  readonly code: KernelLockErrorCode

  constructor(code: KernelLockErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
  }
}
