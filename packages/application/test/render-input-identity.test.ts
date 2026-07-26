import { DomainError, Segment, StableIds, VoiceProfile } from '@light-novel-audiobook/domain'
import { describe, expect, it } from 'vitest'
import {
  createFallbackApprovalRecord,
  createRenderInputIdentity,
  hashSourceText,
  type PersistedFallbackApproval,
} from '../src/index.js'

const SOURCE_HASH = 'b'.repeat(64)
const BOOK_ID = StableIds.book(SOURCE_HASH)
const CHAPTER_ID = StableIds.chapter(BOOK_ID, 1)
const PASSAGE_ID = StableIds.passage(CHAPTER_ID, 1)
const SEGMENT_ID = StableIds.segment(PASSAGE_ID, 1)
const ENGINE = 'qwen:model-revision-1:settings-1'
const LINE = '“Nobody asked either of you.”'

const fallbackVoice = new VoiceProfile({
  id: 'cast-fallback',
  displayName: 'cast-fallback',
  role: 'fallback',
  speakerId: null,
  syntheticSpeaker: 'Ryan',
  instruction: 'Speak in a low, weary, restrained manner.',
  seed: 9205,
  revision: 1,
})

const castVoice = new VoiceProfile({
  id: 'cast-alice',
  displayName: 'cast-alice',
  role: 'character',
  speakerId: 'alice',
  syntheticSpeaker: 'Ryan',
  instruction: 'Speak with energetic confidence.',
  seed: 9204,
  revision: 1,
})

const segmentFor = (usesFallback: boolean): Segment => {
  const segment = new Segment({
    id: SEGMENT_ID,
    chapterId: CHAPTER_ID,
    sourcePassageId: PASSAGE_ID,
    order: 1,
    sourceText: LINE,
    kind: 'dialogue',
    speakerId: usesFallback ? null : 'alice',
    confidence: usesFallback ? 0.4 : 0.98,
    delivery: { emotion: 'cold', pace: 'normal', volume: 'normal', pauseAfterMs: 220 },
  })
  segment.assignVoice({
    voiceProfileId: usesFallback ? fallbackVoice.id : castVoice.id,
    usesFallback,
    fallbackReason: usesFallback ? 'unresolved_speaker' : null,
  })
  return segment
}

const approvalAt = (decidedAt: string): PersistedFallbackApproval =>
  createFallbackApprovalRecord({
    bookId: BOOK_ID,
    segmentId: SEGMENT_ID,
    speakerId: null,
    fallbackReason: 'unresolved_speaker',
    voiceProfileId: fallbackVoice.id,
    sourceTextSha256: hashSourceText(LINE),
    decidedAt,
    decidedBy: 'local-reviewer',
    grantId: null,
  })

describe('render input identity binds the human fallback decision (issue #45, prerequisite 1)', () => {
  it('moves when the approval changes and stays put when it does not', () => {
    const segment = segmentFor(true)
    const first = approvalAt('2026-07-25T10:00:00.000Z')
    const again = approvalAt('2026-07-25T10:00:00.000Z')
    const later = approvalAt('2026-07-25T11:30:00.000Z')

    const approved = createRenderInputIdentity(segment, fallbackVoice, ENGINE, first)
    // Content-addressed: the same decision always addresses the same audio, so re-reconciling an
    // unchanged book must not restale a single segment.
    expect(createRenderInputIdentity(segment, fallbackVoice, ENGINE, again)).toBe(approved)
    // A different decision addresses different audio, which is what makes revoke-then-approve
    // re-render instead of silently serving audio the withdrawn decision authorized.
    expect(createRenderInputIdentity(segment, fallbackVoice, ENGINE, later)).not.toBe(approved)
    // Revoked entirely: the address the existing WAV is stored under is now unreachable.
    expect(createRenderInputIdentity(segment, fallbackVoice, ENGINE, null)).not.toBe(approved)
    expect(createRenderInputIdentity(segment, fallbackVoice, ENGINE)).not.toBe(approved)
  })

  it('gives two segments approved under the same decision time different identities', () => {
    // Guards the property the whole issue turns on: approvals are per segment. If the approval
    // material folded into the hash were not segment-specific, approving speaker A would address
    // speaker B's audio.
    const other = StableIds.segment(StableIds.passage(CHAPTER_ID, 2), 1)
    const otherSegment = new Segment({
      id: other,
      chapterId: CHAPTER_ID,
      sourcePassageId: StableIds.passage(CHAPTER_ID, 2),
      order: 2,
      sourceText: LINE,
      kind: 'dialogue',
      speakerId: null,
      confidence: 0.4,
      delivery: { emotion: 'cold', pace: 'normal', volume: 'normal', pauseAfterMs: 220 },
    })
    otherSegment.assignVoice({
      voiceProfileId: fallbackVoice.id,
      usesFallback: true,
      fallbackReason: 'unresolved_speaker',
    })
    const otherApproval = createFallbackApprovalRecord({
      bookId: BOOK_ID,
      segmentId: other,
      speakerId: null,
      fallbackReason: 'unresolved_speaker',
      voiceProfileId: fallbackVoice.id,
      sourceTextSha256: hashSourceText(LINE),
      decidedAt: '2026-07-25T10:00:00.000Z',
      decidedBy: 'local-reviewer',
      grantId: null,
    })

    expect(otherApproval.approvalId).not.toBe(approvalAt('2026-07-25T10:00:00.000Z').approvalId)
    expect(otherApproval.approvalSha256).not.toBe(
      approvalAt('2026-07-25T10:00:00.000Z').approvalSha256,
    )
    expect(createRenderInputIdentity(otherSegment, fallbackVoice, ENGINE, otherApproval)).not.toBe(
      createRenderInputIdentity(
        segmentFor(true),
        fallbackVoice,
        ENGINE,
        approvalAt('2026-07-25T10:00:00.000Z'),
      ),
    )
  })

  it('refuses to give a cast-voice segment an approval-bound identity', () => {
    expect(() =>
      createRenderInputIdentity(
        segmentFor(false),
        castVoice,
        ENGINE,
        approvalAt('2026-07-25T10:00:00.000Z'),
      ),
    ).toThrow(DomainError)
  })

  it('still moves for every other speech-affecting input', () => {
    const segment = segmentFor(true)
    const approval = approvalAt('2026-07-25T10:00:00.000Z')
    const base = createRenderInputIdentity(segment, fallbackVoice, ENGINE, approval)
    const revisedVoice = new VoiceProfile({
      id: fallbackVoice.id,
      displayName: fallbackVoice.displayName,
      role: 'fallback',
      speakerId: null,
      syntheticSpeaker: fallbackVoice.syntheticSpeaker,
      instruction: fallbackVoice.instruction,
      seed: fallbackVoice.seed,
      revision: 2,
    })
    expect(createRenderInputIdentity(segment, revisedVoice, ENGINE, approval)).not.toBe(base)
    expect(
      createRenderInputIdentity(segment, fallbackVoice, 'qwen:model-revision-2', approval),
    ).not.toBe(base)
    expect(() => createRenderInputIdentity(segment, fallbackVoice, '', approval)).toThrow(
      'Speech engine identity is required',
    )
  })
})
