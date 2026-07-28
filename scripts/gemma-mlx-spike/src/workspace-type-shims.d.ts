/**
 * Type-only stand-ins for the workspace packages that `packages/gemma-director/src/port.ts`
 * imports with `import type`. Those imports are erased at transpile (tsx), so they never
 * resolve at runtime; these declarations exist only so `tsc --noEmit` can typecheck the
 * imported gemma-director sources without installing the pnpm workspace (which the root
 * preinstall gate forbids on Darwin before #108).
 *
 * The shapes below mirror the real workspace sources exactly:
 *   - packages/domain/src/segment.ts (DirectedSegment, DeliveryDirection, SegmentKind)
 *   - packages/application/src/ports.ts (DirectChapterOptions, DirectChapterProgress,
 *     DirectChapterProgressState, DirectedChapter)
 * Book and Chapter appear in port.ts only as opaque parameter types of an interface the
 * spike never constructs, so they stay `unknown` here.
 */
declare module '@light-novel-audiobook/domain' {
  export type SegmentKind = 'narration' | 'dialogue' | 'thought' | 'message' | 'sound_cue'

  export interface DeliveryDirection {
    readonly emotion: string
    readonly pace: 'slow' | 'normal' | 'fast'
    readonly volume: 'soft' | 'normal' | 'loud'
    readonly pauseAfterMs: number
  }

  export interface DirectedSegment {
    readonly sourcePassageId: string
    readonly sourceText: string
    readonly kind: SegmentKind
    readonly speakerId: string | null
    readonly speakerReason?: string | null
    readonly confidence: number
    readonly delivery: DeliveryDirection
  }

  export type Book = unknown
  export type Chapter = unknown
}

declare module '@light-novel-audiobook/application' {
  import type { DirectedSegment } from '@light-novel-audiobook/domain'

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
}
