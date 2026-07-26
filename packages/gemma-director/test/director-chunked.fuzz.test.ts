import { Book, Chapter, ExactSourceCoverage, SourcePassage } from '@light-novel-audiobook/domain'
import { afterEach, describe, expect, it } from 'vitest'
import { planChapterWindows, resolveChunkingSettings } from '../src/chunking.js'
import { DirectorError } from '../src/errors.js'
import { GemmaDirectorModel } from '../src/gemma-director-model.js'
import type {
  DirectedAnnotation,
  DirectionRequest,
  DirectorRuntimeLifecycle,
  ExclusiveGpuLeaseCoordinator,
  GpuLease,
  GpuOwner,
} from '../src/index.js'
import { validateDirectionOutput } from '../src/validation.js'
import {
  mulberry32,
  type Oracle,
  type OracleFragment,
  OracleLlamaServer,
} from './oracle-llama-server.js'

/**
 * Issue #53 fidelity fuzz. The pre-existing mutation suite proves the single-request validator;
 * this fuzz proves the chunked path: random chapters, random window budgets, random exact
 * fragmentations from an independent oracle, through the REAL per-window validator and the REAL
 * stitching, plus adversarial single corruptions that must never pass undetected.
 *
 * Seeds are fixed so any disagreement reproduces exactly.
 */

const CLEAN_CASES = 20_000
const CORRUPTED_CASES = 20_000
const HTTP_CASES = 150

const ALPHABET = ['a', 'b', 'c', 'd', ' ', '.', ',', '!', '?', '”', '“', '\n', 'é', '😀']
const DIALOGUE_KINDS = ['dialogue', 'thought', 'message'] as const

interface FuzzChapter {
  readonly ids: readonly string[]
  readonly texts: readonly string[]
}

function randomText(rand: () => number, units: number): string {
  let text = ''
  while (text.length < units) {
    const piece = ALPHABET[Math.floor(rand() * ALPHABET.length)] as string
    text += piece
  }
  return text
}

function randomChapter(rand: () => number): FuzzChapter {
  const count = 1 + Math.floor(rand() * 12)
  const ids: string[] = []
  const texts: string[] = []
  for (let index = 0; index < count; index += 1) {
    ids.push(`passage-${String(index + 1).padStart(3, '0')}`)
    texts.push(randomText(rand, 1 + Math.floor(rand() * 900)))
  }
  return { ids, texts }
}

/** Offsets that do not split a UTF-16 surrogate pair. */
function validCutPoints(text: string): number[] {
  const points: number[] = []
  for (let offset = 1; offset < text.length; offset += 1) {
    const high = text.charCodeAt(offset - 1)
    const low = text.charCodeAt(offset)
    if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) continue
    points.push(offset)
  }
  return points
}

function randomOracle(rand: () => number, chapter: FuzzChapter, roster: readonly string[]): Oracle {
  const oracle = new Map<string, readonly OracleFragment[]>()
  for (const [index, id] of chapter.ids.entries()) {
    const text = chapter.texts[index] as string
    const cuts = validCutPoints(text)
    const fragmentCount = Math.min(1 + Math.floor(rand() * 3), 1 + cuts.length)
    const chosen = new Set<number>()
    while (chosen.size < fragmentCount - 1) {
      chosen.add(cuts[Math.floor(rand() * cuts.length)] as number)
    }
    const boundaries = [0, ...[...chosen].sort((a, b) => a - b), text.length]
    const fragments: OracleFragment[] = []
    // The first fragment's kind is free; every later fragment must differ from its predecessor,
    // because a split is only meaningful at a kind change.
    let previousKind = ''
    for (let index = 0; index < boundaries.length - 1; index += 1) {
      const dialogue = rand() < 0.45
      const pool: readonly string[] = dialogue ? DIALOGUE_KINDS : ['narration', 'sound_cue']
      let kind = pool[Math.floor(rand() * pool.length)] as string
      if (kind === previousKind) {
        kind = dialogue ? 'narration' : 'dialogue'
      }
      previousKind = kind
      const narratorOwned = kind === 'narration' || kind === 'sound_cue'
      const useFallback = !narratorOwned && rand() < 0.15
      fragments.push({
        start: boundaries[index] as number,
        end: boundaries[index + 1] as number,
        kind: kind as OracleFragment['kind'],
        speaker: narratorOwned
          ? 'narrator'
          : useFallback
            ? 'fallback-dialogue'
            : (roster[Math.floor(rand() * roster.length)] as string),
        unresolved: useFallback,
        confidence: 0.85 + rand() * 0.15,
      })
    }
    oracle.set(id, fragments)
  }
  return oracle
}

interface WireSegment {
  source_passage_id: string
  source_start: number
  source_end: number
  source_text: string
  kind: string
  speaker_id: string
  confidence: number
  delivery: { emotion: string; pace: string; volume: string; pause_after_ms: number }
  unresolved_speaker: boolean
  speaker_reason: string | null
}

function wireOutput(
  chapter: FuzzChapter,
  oracle: Oracle,
  passageIds: readonly string[],
): { segments: WireSegment[] } {
  return {
    segments: passageIds.flatMap((id) => {
      const text = chapter.texts[chapter.ids.indexOf(id)] as string
      return (oracle.get(id) ?? []).map((fragment) => ({
        source_passage_id: id,
        source_start: fragment.start,
        source_end: fragment.end,
        source_text: text.slice(fragment.start, fragment.end),
        kind: fragment.kind,
        speaker_id: fragment.speaker,
        confidence: fragment.confidence,
        delivery: { emotion: 'calm', pace: 'normal', volume: 'normal', pause_after_ms: 200 },
        unresolved_speaker: fragment.unresolved,
        speaker_reason: fragment.unresolved ? 'Not identified in context.' : null,
      }))
    }),
  }
}

function requestFor(
  chapter: FuzzChapter,
  passageIds: readonly string[],
  roster: readonly string[],
  storyContext: string,
): DirectionRequest {
  return {
    requestId: 'fuzz-request',
    bookId: 'book-fuzz',
    bookTitle: 'Fuzz Book',
    bookAuthor: null,
    bookSourceSha256: 'a'.repeat(64),
    chapterId: 'chapter-fuzz',
    chapterPosition: 1,
    chapterTitle: 'Fuzz Chapter',
    passages: passageIds.map((id) => ({
      id,
      text: chapter.texts[chapter.ids.indexOf(id)] as string,
    })),
    speakers: roster.map((id) => ({ id, aliases: [id] })),
    narratorSpeakerId: 'narrator',
    fallbackSpeakerId: 'fallback-dialogue',
    storyContext,
  }
}

interface PipelineResult {
  readonly annotations: readonly DirectedAnnotation[]
  readonly windowCount: number
}

/**
 * The chunked validation+stitch pipeline, exactly as GemmaDirectorModel drives it: plan windows,
 * validate each window's wire output against that window's request, concatenate in window order.
 */
function runChunkedPipeline(
  chapter: FuzzChapter,
  outputs: readonly { segments: WireSegment[] }[],
  windows: readonly { start: number; end: number }[],
  roster: readonly string[],
  storyContext: string,
): PipelineResult {
  if (outputs.length !== windows.length) throw new Error('test harness misuse')
  const annotations: DirectedAnnotation[] = []
  for (const [index, window] of windows.entries()) {
    const passageIds = chapter.ids.slice(window.start, window.end)
    const validated = validateDirectionOutput(
      outputs[index],
      requestFor(chapter, passageIds, roster, storyContext),
      0.8,
    )
    annotations.push(...validated.annotations)
  }
  return { annotations, windowCount: windows.length }
}

function planFor(chapter: FuzzChapter, rand: () => number) {
  const settings = resolveChunkingSettings({
    windowCharBudget: 40 + Math.floor(rand() * 4_000),
    windowPassageBudget: 1 + Math.floor(rand() * 6),
    outputCharsBudget: 1_000_000,
  })
  const passages = chapter.ids.map((id, index) => ({
    id,
    text: chapter.texts[index] as string,
  }))
  return planChapterWindows(passages, settings)
}

describe('issue #53 chunked fidelity fuzz (seeded, independent oracle)', () => {
  it('stitches random exact fragmentations back to the oracle across random windows', () => {
    const rand = mulberry32(0x5357_0001)
    let multiWindowCases = 0
    for (let testCase = 0; testCase < CLEAN_CASES; testCase += 1) {
      const chapter = randomChapter(rand)
      const roster = ['mira', 'paul', 'rudeus'].slice(0, 1 + Math.floor(rand() * 3))
      const storyContext = randomText(rand, Math.floor(rand() * 200))
      const oracle = randomOracle(rand, chapter, roster)
      const windows = planFor(chapter, rand)
      if (windows.length > 1) multiWindowCases += 1

      // Boundary integrity at scale: the planned windows tile the chapter exactly.
      expect(windows[0]?.start).toBe(0)
      expect(windows.at(-1)?.end).toBe(chapter.ids.length)
      for (let index = 1; index < windows.length; index += 1) {
        expect(windows[index]?.start).toBe(windows[index - 1]?.end)
      }

      const outputs = windows.map((window) =>
        wireOutput(chapter, oracle, chapter.ids.slice(window.start, window.end)),
      )
      const { annotations } = runChunkedPipeline(chapter, outputs, windows, roster, storyContext)

      // The stitched annotations must reproduce the oracle EXACTLY: order, ranges, text, kinds.
      const oracleFlat = chapter.ids.flatMap((id) =>
        (oracle.get(id) ?? []).map((fragment) => ({ id, fragment })),
      )
      expect(annotations.length).toBe(oracleFlat.length)
      for (const [index, { id, fragment }] of oracleFlat.entries()) {
        const annotation = annotations[index]
        const text = chapter.texts[chapter.ids.indexOf(id)] as string
        expect(annotation?.sourcePassageId).toBe(id)
        expect(annotation?.sourceStart).toBe(fragment.start)
        expect(annotation?.sourceEnd).toBe(fragment.end)
        expect(annotation?.sourceText).toBe(text.slice(fragment.start, fragment.end))
        expect(annotation?.kind).toBe(fragment.kind)
        expect(annotation?.speakerId).toBe(fragment.speaker)
      }
      // And every passage reconstructs exactly.
      for (const [index, id] of chapter.ids.entries()) {
        const rebuilt = annotations
          .filter((annotation) => annotation.sourcePassageId === id)
          .map((annotation) => annotation.sourceText)
          .join('')
        expect(rebuilt).toBe(chapter.texts[index])
      }
    }
    // Guard the fuzz itself: it must actually exercise multi-window stitching.
    expect(multiWindowCases).toBeGreaterThan(CLEAN_CASES * 0.5)
  })

  it('never lets a single corruption through the chunked pipeline undetected', () => {
    const rand = mulberry32(0x5357_0002)
    const corruptionCounts = new Map<string, number>()
    for (let testCase = 0; testCase < CORRUPTED_CASES; testCase += 1) {
      const chapter = randomChapter(rand)
      const roster = ['mira', 'paul'].slice(0, 1 + Math.floor(rand() * 2))
      const storyContext = randomText(rand, Math.floor(rand() * 120))
      const oracle = randomOracle(rand, chapter, roster)
      const windows = planFor(chapter, rand)
      const outputs = windows.map((window) =>
        wireOutput(chapter, oracle, chapter.ids.slice(window.start, window.end)),
      )

      const totalFragments = outputs.reduce((sum, output) => sum + output.segments.length, 0)
      const corruption = Math.floor(rand() * 7)
      const windowIndex = Math.floor(rand() * windows.length)
      let applied = ''
      const cloneOutputs = (): { segments: WireSegment[] }[] =>
        outputs.map((item) => ({ segments: item.segments.map((segment) => ({ ...segment })) }))
      const corrupted = cloneOutputs()
      const target = corrupted[windowIndex] as { segments: WireSegment[] }

      switch (corruption) {
        case 0: {
          // drop a fragment
          if (target.segments.length === 0) continue
          target.segments.splice(Math.floor(rand() * target.segments.length), 1)
          applied = 'drop'
          break
        }
        case 1: {
          // duplicate a fragment
          if (target.segments.length === 0) continue
          const at = Math.floor(rand() * target.segments.length)
          const copy = target.segments[at]
          if (copy === undefined) continue
          target.segments.splice(at, 0, { ...copy })
          applied = 'duplicate'
          break
        }
        case 2: {
          // swap two fragments inside one window
          if (target.segments.length < 2) continue
          const a = Math.floor(rand() * target.segments.length)
          let b = Math.floor(rand() * target.segments.length)
          if (a === b) b = (b + 1) % target.segments.length
          const left = target.segments[a]
          const right = target.segments[b]
          if (left === undefined || right === undefined) continue
          target.segments[a] = right
          target.segments[b] = left
          applied = 'swap-within'
          break
        }
        case 3: {
          // rewrite one character of one fragment's echoed source_text
          if (target.segments.length === 0) continue
          const segment = target.segments[Math.floor(rand() * target.segments.length)]
          if (segment === undefined) continue
          const at = Math.floor(rand() * segment.source_text.length)
          const current = segment.source_text.charAt(at)
          const replacement = current === 'X' ? 'Y' : 'X'
          segment.source_text =
            segment.source_text.slice(0, at) + replacement + segment.source_text.slice(at + 1)
          applied = 'rewrite'
          break
        }
        case 4: {
          // nudge an offset while leaving source_text as it was
          if (target.segments.length === 0) continue
          const segment = target.segments[Math.floor(rand() * target.segments.length)]
          if (segment === undefined) continue
          if (segment.source_start + 1 < segment.source_end) {
            segment.source_start += 1
          } else {
            segment.source_end = segment.source_start
          }
          applied = 'offset-nudge'
          break
        }
        case 5: {
          // move a fragment into a different window's output
          if (windows.length < 2 || target.segments.length === 0) continue
          const at = Math.floor(rand() * target.segments.length)
          const [moved] = target.segments.splice(at, 1)
          if (moved === undefined) continue
          const otherIndex = (windowIndex + 1) % windows.length
          ;(corrupted[otherIndex] as { segments: WireSegment[] }).segments.push(moved)
          applied = 'move-across-windows'
          break
        }
        default: {
          // swap two whole window outputs, as a stitching-order mistake would present
          if (windows.length < 2) continue
          const otherIndex = (windowIndex + 1) % windows.length
          const hold = corrupted[windowIndex]
          const other = corrupted[otherIndex]
          if (hold === undefined || other === undefined) continue
          corrupted[windowIndex] = other
          corrupted[otherIndex] = hold
          applied = 'swap-windows'
          break
        }
      }
      if (applied === '') continue
      corruptionCounts.set(applied, (corruptionCounts.get(applied) ?? 0) + 1)

      let rejected = false
      try {
        runChunkedPipeline(chapter, corrupted, windows, roster, storyContext)
      } catch (error) {
        rejected = true
        expect(error).toBeInstanceOf(DirectorError)
      }
      if (!rejected) {
        throw new Error(
          `Corruption "${applied}" passed undetected in case ${testCase} ` +
            `(${totalFragments} fragments, ${windows.length} windows)`,
        )
      }
    }
    // Guard the fuzz itself: every corruption family must have run a meaningful number of times.
    for (const family of ['drop', 'duplicate', 'swap-within', 'rewrite', 'offset-nudge']) {
      expect(corruptionCounts.get(family) ?? 0).toBeGreaterThan(500)
    }
    expect(corruptionCounts.get('move-across-windows') ?? 0).toBeGreaterThan(200)
    expect(corruptionCounts.get('swap-windows') ?? 0).toBeGreaterThan(200)
  })
})

describe('issue #53 chunked fidelity fuzz through the HTTP adapter', () => {
  let server: OracleLlamaServer | undefined
  const models: GemmaDirectorModel[] = []

  afterEach(async () => {
    await Promise.allSettled(models.splice(0).map(async (model) => await model.release()))
    await server?.stop()
    server = undefined
  })

  it('directs random chapters through real windows with exact reconstruction', async () => {
    const rand = mulberry32(0x5357_0003)
    for (let testCase = 0; testCase < HTTP_CASES; testCase += 1) {
      const passageCount = 2 + Math.floor(rand() * 24)
      const ids: string[] = []
      const texts: string[] = []
      for (let index = 0; index < passageCount; index += 1) {
        ids.push(`passage-${String(index + 1).padStart(3, '0')}`)
        texts.push(randomText(rand, 1 + Math.floor(rand() * 700)))
      }
      const chapter: FuzzChapter = { ids, texts }
      const oracle = randomOracle(rand, chapter, ['mira'])
      server = new OracleLlamaServer(oracle)
      await server.start()

      const domainChapter = new Chapter({
        id: 'chapter-fuzz',
        bookId: 'book-fuzz',
        position: 1,
        title: 'Fuzz',
        sourcePassages: ids.map(
          (id, index) =>
            new SourcePassage({
              id,
              chapterId: 'chapter-fuzz',
              sourceText: texts[index] as string,
            }),
        ),
      })
      const book = new Book({
        id: 'book-fuzz',
        title: 'Fuzz Book',
        author: null,
        coverPath: null,
        source: { epubPath: '/fuzz.epub', sha256: 'a'.repeat(64) },
        chapters: [domainChapter],
      })
      const model = new GemmaDirectorModel({
        baseUrl: server.baseUrl,
        apiKey: 'fake-server-side-key-0000000001',
        confidenceThreshold: 0.8,
        contextProvider: {
          forChapter: async () => ({
            speakers: [{ id: 'mira', aliases: ['Mira'] }],
            narratorSpeakerId: 'narrator',
            fallbackSpeakerId: 'fallback-dialogue',
            storyContext: 'Fuzz context.',
          }),
        },
        progressStore: { async append() {} },
        lifecycle: new (class implements DirectorRuntimeLifecycle {
          async start(): Promise<void> {}
          async release(): Promise<void> {}
        })(),
        gpuLeaseCoordinator: new (class implements ExclusiveGpuLeaseCoordinator {
          async acquire(owner: GpuOwner): Promise<GpuLease> {
            return {
              owner,
              lockFilePath: '/fuzz/gpu.lock',
              quarantine: async () => {},
              release: async () => {},
            }
          }
        })(),
        gpuLeaseLockFilePath: '/fuzz/gpu.lock',
        chunking: {
          windowCharBudget: 40 + Math.floor(rand() * 2_000),
          windowPassageBudget: 1 + Math.floor(rand() * 5),
          outputCharsBudget: 1_000_000,
        },
      })
      models.push(model)

      const result = await model.directChapter(book, domainChapter)

      // The application boundary's own independent proof accepts the stitched direction.
      expect(() => ExactSourceCoverage.createSegments(domainChapter, result.segments)).not.toThrow()
      for (const [index, id] of ids.entries()) {
        const rebuilt = result.segments
          .filter((segment) => segment.sourcePassageId === id)
          .map((segment) => segment.sourceText)
          .join('')
        expect(rebuilt).toBe(texts[index])
      }
      // Every request asked for a contiguous slice, and the slices tile the chapter.
      const asked = server.requests.flatMap((request) =>
        request.passages.map((passage) => passage.source_passage_id),
      )
      expect(asked).toEqual(ids)

      await model.release()
      models.pop()
      await server.stop()
      server = undefined
    }
  }, 120_000)
})
