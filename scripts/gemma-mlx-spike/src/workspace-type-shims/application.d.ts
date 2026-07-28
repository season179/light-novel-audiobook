/**
 * Local type module that tsc resolves the bare specifier
 * `@light-novel-audiobook/application` to, via the `tsconfig.json` `paths` entry.
 *
 * `packages/gemma-director/src/port.ts` imports `DirectChapterOptions`,
 * `DirectChapterProgress`, `DirectChapterProgressState` and `DirectedChapter`
 * from this specifier with `import type`, so the import is erased at transpile
 * (tsx) and never resolves at runtime. Because `paths` takes precedence over
 * the node_modules walk, this file is the module tsc uses whether or not the
 * pnpm workspace links exist at the repo root — that keeps the spike's
 * `tsc --noEmit` from ever traversing `packages/application` (issue #123
 * regression).
 *
 * The shapes mirror the real workspace source exactly:
 *   - packages/application/src/ports.ts (DirectedChapter, DirectChapterProgress,
 *     DirectChapterProgressState, DirectChapterOptions)
 */
import type { DirectedSegment } from './domain'

export interface DirectedChapter {
  readonly chapterId: string
  readonly segments: readonly DirectedSegment[]
}

export type DirectChapterProgressState =
  | 'started'
  | 'requesting'
  | 'response_started'
  | 'streaming'
  | 'validating'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface DirectChapterProgress {
  readonly chapterId: string
  readonly state: DirectChapterProgressState
  readonly completedPassages: number
  readonly totalPassages: number
  readonly message: string
}

export interface DirectChapterOptions {
  readonly signal?: AbortSignal
  readonly onProgress?: ((progress: DirectChapterProgress) => void | Promise<void>) | undefined
  readonly timeoutMs?: number
}
