import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AssembleAudiobookRequest,
  CompletedSegmentAudio,
} from '@light-novel-audiobook/application'
import {
  Book,
  Chapter,
  ExactSourceCoverage,
  type Segment,
  SourcePassage,
  StableIds,
  type VoiceCast,
  VoiceProfile,
} from '@light-novel-audiobook/domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeAudioAssembler } from '../src/server/fakes/fake-audio-assembler.js'
import { FakeDirectorModel } from '../src/server/fakes/fake-director-model.js'
import {
  FakeSpeechEngine,
  type FakeSpeechEngineOptions,
} from '../src/server/fakes/fake-speech-engine.js'
import {
  createM1VoiceCast,
  loadPinnedQwenConfig,
  pinnedVoiceMaterial,
} from '../src/server/m1-voice-cast.js'
import { createWorkspace, type LocalWorkspace } from '../src/server/workspace.js'

/**
 * Every fake must refuse what its merged real counterpart refuses. A fake that is more permissive
 * than reality manufactures confidence, and in this issue it hid a defect three rounds running.
 * These tests pin each rejection against the behaviour of `QwenApplicationSpeechEngine`,
 * `GemmaDirectorModel` and the FFmpeg assembly planner.
 */
const sha256 = 'c'.repeat(64)
const bookId = StableIds.book(sha256)
const chapterId = StableIds.chapter(bookId, 1)
const passageId = StableIds.passage(chapterId, 1)

let workspace: LocalWorkspace
let root: string
let voices: VoiceCast
let pinned: readonly { syntheticSpeaker: string; instruction: string; seed: number }[]

const buildBook = (): Book =>
  new Book({
    id: bookId,
    title: 'Contract Book',
    author: null,
    coverPath: null,
    source: { epubPath: '/uploads/contract.epub', sha256 },
    chapters: [
      new Chapter({
        id: chapterId,
        bookId,
        position: 1,
        title: 'Only Chapter',
        sourcePassages: [
          new SourcePassage({
            id: passageId,
            chapterId,
            sourceText: 'A quiet room. “Who is there?” Bruno asked.',
          }),
        ],
      }),
    ],
  })

/** Directs and casts the fixture the way the use case does, so segments carry real assignments. */
const directedBook = async (): Promise<{ book: Book; segments: readonly Segment[] }> => {
  const book = buildBook()
  const chapter = book.chapters[0]
  if (chapter === undefined) throw new Error('fixture chapter missing')
  const directed = await new FakeDirectorModel().directChapter(book, chapter)
  const segments = ExactSourceCoverage.createSegments(chapter, directed.segments)
  for (const segment of segments) {
    segment.assignVoice(voices.resolve(segment).assignment)
  }
  chapter.submitForReview(segments)
  chapter.approve()
  return { book, segments }
}

const renderRequest = (segment: Segment, overrides: { inputIdentity?: string } = {}) => {
  const assignment = segment.voiceAssignment
  if (assignment === null) throw new Error('segment has no voice')
  return {
    segment,
    voice: voices.profile(assignment.voiceProfileId),
    inputIdentity: overrides.inputIdentity ?? 'a'.repeat(64),
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lna-contract-'))
  workspace = await createWorkspace(root)
  const pinnedConfig = await loadPinnedQwenConfig()
  voices = createM1VoiceCast(pinnedConfig)
  pinned = pinnedVoiceMaterial(pinnedConfig)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('FakeSpeechEngine mirrors the merged Qwen adapter', () => {
  const engine = (options: FakeSpeechEngineOptions = {}) =>
    new FakeSpeechEngine(workspace, {
      fallbackVoiceProfileId: voices.fallback.id,
      pinnedVoiceProfiles: pinned,
      ...options,
    })

  it('rejects a render outside a batch and a second open batch', async () => {
    const { segments } = await directedBook()
    const narration = segments[0]
    if (narration === undefined) return
    const speech = engine()

    await expect(speech.render(renderRequest(narration))).rejects.toThrow(/outside a batch/)
    await speech.beginBatch()
    await expect(speech.beginBatch()).rejects.toThrow(/already open/)
  })

  it('rejects an inputIdentity that is not a SHA-256', async () => {
    const { segments } = await directedBook()
    const narration = segments[0]
    if (narration === undefined) return
    const speech = engine()
    await speech.beginBatch()

    await expect(
      speech.render(renderRequest(narration, { inputIdentity: 'not-a-hash' })),
    ).rejects.toThrow(/SHA-256/)
  })

  it('rejects fallback speech with no per-segment human approval', async () => {
    const { segments } = await directedBook()
    const fallback = segments.find((segment) => segment.voiceAssignment?.usesFallback === true)
    expect(fallback).toBeDefined()
    if (fallback === undefined) return
    const speech = engine()
    await speech.beginBatch()

    await expect(speech.render(renderRequest(fallback))).rejects.toThrow(
      /no explicit human approval identity/,
    )
  })

  it('rejects an approval that names a different speaker or reason', async () => {
    const { segments } = await directedBook()
    const fallback = segments.find((segment) => segment.voiceAssignment?.usesFallback === true)
    if (fallback === undefined) return
    const speech = engine({
      fallbackApprovals: [
        {
          segmentId: fallback.id,
          speakerId: 'somebody-else',
          fallbackReason: 'missing_speaker_voice',
          approvalId: 'approval-1',
          approvalSha256: 'd'.repeat(64),
        },
      ],
    })
    await speech.beginBatch()

    await expect(speech.render(renderRequest(fallback))).rejects.toThrow(
      /does not match its unresolved speaker decision/,
    )
  })

  it('accepts a matching approval, and records what the M1 stand-in auto-approved', async () => {
    const { segments } = await directedBook()
    const fallback = segments.find((segment) => segment.voiceAssignment?.usesFallback === true)
    if (fallback === undefined) return

    const approved = engine({
      fallbackApprovals: [
        {
          segmentId: fallback.id,
          speakerId: fallback.speakerId,
          fallbackReason: fallback.voiceAssignment?.fallbackReason ?? 'missing_speaker_voice',
          approvalId: 'approval-1',
          approvalSha256: 'd'.repeat(64),
        },
      ],
    })
    await approved.beginBatch()
    await expect(approved.render(renderRequest(fallback))).resolves.toMatchObject({
      segmentId: fallback.id,
    })

    // There is no option, policy or default that renders an unapproved fallback segment. The
    // `'auto-approve'` stand-in that used to live here is gone, and its renamed successor in the
    // application layer was removed in issue #45's round 2.
    const unapproved = engine()
    await unapproved.beginBatch()
    await expect(unapproved.render(renderRequest(fallback))).rejects.toThrow(
      'no explicit human approval identity',
    )

    // A catalog replaced per book, as the factory does after review, authorizes only what it names.
    const swapped = engine()
    swapped.replaceApprovals([
      {
        segmentId: fallback.id,
        speakerId: fallback.speakerId,
        fallbackReason: fallback.voiceAssignment?.fallbackReason ?? 'missing_speaker_voice',
        approvalId: 'approval-2',
        approvalSha256: 'e'.repeat(64),
      },
    ])
    await swapped.beginBatch()
    await expect(swapped.render(renderRequest(fallback))).resolves.toMatchObject({
      segmentId: fallback.id,
    })
    swapped.replaceApprovals([])
    await expect(swapped.render(renderRequest(fallback))).rejects.toThrow(
      'no explicit human approval identity',
    )
  })

  it('rejects a voice that is not the segment’s assignment', async () => {
    const { segments } = await directedBook()
    const narration = segments[0]
    if (narration === undefined) return
    const speech = engine()
    await speech.beginBatch()

    const wrongVoice = new VoiceProfile({
      id: 'someone-else',
      displayName: 'Someone Else',
      role: 'narrator',
      speakerId: null,
      syntheticSpeaker: 'Aiden',
      instruction: 'Other.',
      seed: 9,
      revision: 1,
    })

    await expect(speech.render({ ...renderRequest(narration), voice: wrongVoice })).rejects.toThrow(
      /voice assignment mismatch/,
    )
  })
})

describe('FakeAudioAssembler mirrors the merged FFmpeg planner', () => {
  const audioFor = (segment: Segment): CompletedSegmentAudio => ({
    segmentId: segment.id,
    inputIdentity: 'a'.repeat(64),
    wavPath: join(workspace.segmentsDir, `${segment.id}.wav`),
    sha256: 'b'.repeat(64),
    byteLength: 64,
  })

  const request = async (
    mutate: (request: AssembleAudiobookRequest) => AssembleAudiobookRequest,
  ): Promise<AssembleAudiobookRequest> => {
    const { book, segments } = await directedBook()
    const chapter = book.chapters[0]
    if (chapter === undefined) throw new Error('fixture chapter missing')
    const directory = join(workspace.outputsDir, book.id)
    return mutate({
      book,
      chapters: [
        { chapter, segments: segments.map((segment) => ({ segment, audio: audioFor(segment) })) },
      ],
      reservation: {
        bookId: book.id,
        version: { value: 1, label: 'v001', fileName: () => 'unused' } as never,
        m4bPath: join(directory, 'contract-book-v001.m4b'),
        chapters: [
          { chapterId: chapter.id, path: join(directory, 'contract-book-v001-ch0001.wav') },
        ],
      },
    })
  }

  it('refuses a reserved chapter extension it cannot produce', async () => {
    const assembler = new FakeAudioAssembler()
    const flac = await request((base) => ({
      ...base,
      reservation: {
        ...base.reservation,
        chapters: base.reservation.chapters.map((chapter) => ({
          ...chapter,
          path: chapter.path.replace(/\.wav$/, '.flac'),
        })),
      },
    }))

    await expect(assembler.assemble(flac)).rejects.toThrow(/cannot honour reserved chapter master/)
  })

  it('refuses audio supplied for the wrong segment', async () => {
    const assembler = new FakeAudioAssembler()
    const swapped = await request((base) => ({
      ...base,
      chapters: base.chapters.map((entry) => ({
        ...entry,
        segments: entry.segments.map((item) => ({
          ...item,
          audio: { ...item.audio, segmentId: 'some-other-segment' },
        })),
      })),
    }))

    await expect(assembler.assemble(swapped)).rejects.toThrow(/was supplied for segment/)
  })

  it('refuses a truncated segment list', async () => {
    const assembler = new FakeAudioAssembler()
    const truncated = await request((base) => ({
      ...base,
      chapters: base.chapters.map((entry) => ({ ...entry, segments: entry.segments.slice(0, 1) })),
    }))

    await expect(assembler.assemble(truncated)).rejects.toThrow(/segments but the approved chapter/)
  })

  it('never overwrites an existing reserved output', async () => {
    const assembler = new FakeAudioAssembler()
    const first = await request((base) => base)
    // Real segment clips have to exist for the concatenation step.
    const speech = new FakeSpeechEngine(workspace, {
      fallbackVoiceProfileId: voices.fallback.id,
      pinnedVoiceProfiles: pinned,
    })
    const chapterEntry = first.chapters[0]
    if (chapterEntry === undefined) return
    // Every fallback segment needs a decision, exactly as it does in the real flow. This test is
    // about output reservation, so the decisions are supplied directly rather than reviewed.
    speech.replaceApprovals(
      chapterEntry.segments
        .filter((item) => item.segment.voiceAssignment?.usesFallback === true)
        .map((item, index) => ({
          segmentId: item.segment.id,
          speakerId: item.segment.speakerId,
          fallbackReason: item.segment.voiceAssignment?.fallbackReason ?? 'missing_speaker_voice',
          approvalId: `approval-reservation-${index + 1}`,
          approvalSha256: 'f'.repeat(64),
        })),
    )
    await speech.beginBatch()
    const rendered = []
    for (const item of chapterEntry.segments) {
      rendered.push({
        segment: item.segment,
        audio: await speech.render(renderRequest(item.segment)),
      })
    }
    await speech.endBatch()
    const runnable: AssembleAudiobookRequest = {
      ...first,
      chapters: [{ chapter: chapterEntry.chapter, segments: rendered }],
    }

    await expect(assembler.assemble(runnable)).resolves.toMatchObject({
      m4bPath: first.reservation.m4bPath,
    })
    await expect(assembler.assemble(runnable)).rejects.toThrow(/must never be overwritten/)
  })
})
