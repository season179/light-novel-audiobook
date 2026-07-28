/**
 * Local type module that tsc resolves the bare specifier
 * `@light-novel-audiobook/domain` to, via the `tsconfig.json` `paths` entry.
 *
 * `packages/gemma-director/src/port.ts` imports `Book`, `Chapter` and
 * `DirectedSegment` (and the `DirectedSegment` field shapes `SegmentKind` and
 * `DeliveryDirection`) from this specifier with `import type`, so the import is
 * erased at transpile (tsx) and never resolves at runtime. Because `paths`
 * takes precedence over the node_modules walk, this file is the module tsc uses
 * whether or not the pnpm workspace links exist at the repo root — that keeps
 * the spike's `tsc --noEmit` from ever traversing `packages/application` or
 * `packages/domain` (issue #123 regression).
 *
 * The shapes mirror the real workspace source exactly:
 *   - packages/domain/src/segment.ts (SegmentKind, DeliveryDirection, DirectedSegment)
 * `Book` and `Chapter` appear in port.ts only as opaque parameter types of an
 * interface the spike never constructs, so they stay `unknown` here.
 */
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
