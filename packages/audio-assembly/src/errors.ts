/** Adapter-level failures. Domain rules keep raising DomainError from the domain package. */
export class AudioAssemblyError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
  }
}

/** The pinned FFmpeg toolchain is missing, unusable, or the wrong version. */
export class FfmpegToolchainError extends AudioAssemblyError {}

/** An assembly request contradicts the chapter or segment order it must preserve. */
export class AssemblyOrderError extends AudioAssemblyError {}

/** A reserved output already exists on disk. Never downgraded to an overwrite. */
export class OutputExistsError extends AudioAssemblyError {
  readonly path: string

  constructor(path: string, detail = 'Refusing to overwrite an existing output') {
    super(`${detail}: ${path}`)
    this.path = path
  }
}

export class FfmpegProcessError extends AudioAssemblyError {
  readonly executable: string
  readonly args: readonly string[]
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stderr: string

  constructor(input: {
    readonly message: string
    readonly executable: string
    readonly args: readonly string[]
    readonly exitCode: number | null
    readonly signal: NodeJS.Signals | null
    readonly stderr: string
  }) {
    super(`${input.message}\n${input.stderr.trim()}`.trimEnd())
    this.executable = input.executable
    this.args = Object.freeze([...input.args])
    this.exitCode = input.exitCode
    this.signal = input.signal
    this.stderr = input.stderr
  }
}
