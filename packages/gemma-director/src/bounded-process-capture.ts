import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Hard bound for one owned llama-server lifecycle capture, including its header. */
export const OWNED_LLAMA_CAPTURE_MAX_BYTES = 1024 * 1024
const HEADER_RESERVE = 512
const HEAD_LIMIT = 256 * 1024
const TAIL_LIMIT = OWNED_LLAMA_CAPTURE_MAX_BYTES - HEADER_RESERVE - HEAD_LIMIT

/**
 * Continuously consumes both child pipes into a bounded head/tail buffer. Disk writes are snapshots
 * of that buffer and are deliberately best effort: ENOSPC, permissions and disappearing directories
 * can make diagnostics unavailable, but can never reject lifecycle start/release.
 */
export class BoundedProcessCapture {
  readonly path: string
  #head = Buffer.alloc(0)
  #tail: Buffer[] = []
  #tailBytes = 0
  #observedBytes = 0
  #persisting: Promise<void> = Promise.resolve()

  constructor(path: string) {
    this.path = path
  }

  append(stream: 'stdout' | 'stderr' | 'lifecycle', chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')
    const separator = bytes.length > 0 && bytes[bytes.length - 1] === 0x0a ? '' : '\n'
    const framed = Buffer.concat([Buffer.from(`[${stream}] `), bytes, Buffer.from(separator)])
    this.#observedBytes += framed.length

    const headRemaining = HEAD_LIMIT - this.#head.length
    const headPart = framed.subarray(0, Math.max(0, headRemaining))
    if (headPart.length > 0) this.#head = Buffer.concat([this.#head, headPart])
    const tailPart = framed.subarray(headPart.length)
    if (tailPart.length === 0) return
    this.#tail.push(tailPart)
    this.#tailBytes += tailPart.length
    this.#trimTail()
  }

  mark(phase: 'starting' | 'healthy' | 'startup_failed' | 'exited'): void {
    // Wall clock is correct here: this records when an event happened, never a duration.
    this.append('lifecycle', `phase=${phase} at=${new Date().toISOString()}`)
  }

  persist(): Promise<void> {
    const bytes = this.#render()
    this.#persisting = this.#persisting.then(async () => {
      try {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
        await writeFile(this.path, bytes, { mode: 0o600 })
      } catch {
        // Diagnostic capture is intentionally non-fatal. Pipes remain drained in memory.
      }
    })
    return this.#persisting
  }

  async settled(): Promise<void> {
    await this.#persisting
  }

  #trimTail(): void {
    while (this.#tailBytes > TAIL_LIMIT && this.#tail.length > 0) {
      const excess = this.#tailBytes - TAIL_LIMIT
      const first = this.#tail[0]
      if (first === undefined) break
      if (first.length <= excess) {
        this.#tail.shift()
        this.#tailBytes -= first.length
      } else {
        this.#tail[0] = first.subarray(excess)
        this.#tailBytes -= excess
      }
    }
  }

  #render(): Buffer {
    const truncated = this.#observedBytes > this.#head.length + this.#tailBytes
    const header = Buffer.from(
      `capture_schema=1\nmax_bytes=${OWNED_LLAMA_CAPTURE_MAX_BYTES}\nobserved_bytes=${this.#observedBytes}\ntruncated=${truncated}\n`,
    )
    const marker = truncated ? Buffer.from('\n[capture] middle bytes omitted\n') : Buffer.alloc(0)
    const rendered = Buffer.concat([header, this.#head, marker, ...this.#tail])
    if (rendered.length <= OWNED_LLAMA_CAPTURE_MAX_BYTES) return rendered
    return Buffer.concat([
      rendered.subarray(0, HEAD_LIMIT),
      Buffer.from('\n[capture] middle bytes omitted\n'),
      rendered.subarray(rendered.length - (OWNED_LLAMA_CAPTURE_MAX_BYTES - HEAD_LIMIT - 34)),
    ]).subarray(0, OWNED_LLAMA_CAPTURE_MAX_BYTES)
  }
}
