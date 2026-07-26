import { DomainError } from '@light-novel-audiobook/domain'
import { describe, expect, it } from 'vitest'
import {
  type CastProposal,
  createCastApprovalRecord,
  type PersistedCastApproval,
  parseCastProposal,
  ReviewCastApprovals,
  sharedVoiceMaterialGroups,
} from '../src/index.js'
import type { CastApprovalRepository } from '../src/ports.js'

class InMemoryCastApprovals implements CastApprovalRepository {
  approval: PersistedCastApproval | undefined

  async findCastApproval(): Promise<PersistedCastApproval | undefined> {
    return this.approval
  }

  async saveCastApproval(approval: PersistedCastApproval): Promise<void> {
    this.approval = approval
  }
}

const proposal = () =>
  parseCastProposal({
    bookId: 'book-abc123',
    epubSha256: 'a'.repeat(64),
    assignments: [
      {
        speakerId: 'speaker-amber',
        aliases: ['Captain Amber', 'Amber'],
        materialProfileId: 'material-bright',
        sharingGroupId: null,
      },
      {
        speakerId: 'speaker-basil',
        aliases: ['Basil'],
        materialProfileId: 'material-low',
        sharingGroupId: 'minor-cast-low',
      },
      {
        speakerId: 'speaker-coral',
        aliases: ['Coral'],
        materialProfileId: 'material-low',
        sharingGroupId: 'minor-cast-low',
      },
    ],
  })

describe('cast proposal and human approval', () => {
  it('records an actor-attributed decision and exposes deliberate material sharing', async () => {
    const repository = new InMemoryCastApprovals()
    const review = new ReviewCastApprovals({
      approvals: repository,
      allowedMaterialProfileIds: ['material-bright', 'material-low'],
      now: () => new Date('2026-07-26T12:00:00.000Z'),
    })

    const approved = await review.approve({ proposal: proposal(), decidedBy: 'Reviewer One' })

    expect(approved).toMatchObject({
      decidedBy: 'Reviewer One',
      decidedAt: '2026-07-26T12:00:00.000Z',
      approvalId: expect.stringMatching(/^cast-[a-f\d]{24}$/),
    })
    expect(await review.findForEpub('a'.repeat(64))).toBe(approved)
    expect(sharedVoiceMaterialGroups(approved.assignments)).toEqual([
      {
        sharingGroupId: 'minor-cast-low',
        materialProfileId: 'material-low',
        speakerIds: ['speaker-basil', 'speaker-coral'],
      },
    ])
  })

  it('rejects silent reuse instead of trusting an instruction to disclose it', () => {
    expect(() =>
      parseCastProposal({
        bookId: 'book-abc123',
        epubSha256: 'a'.repeat(64),
        assignments: [
          {
            speakerId: 'speaker-amber',
            aliases: ['Amber'],
            materialProfileId: 'material-bright',
            sharingGroupId: null,
          },
          {
            speakerId: 'speaker-basil',
            aliases: ['Basil'],
            materialProfileId: 'material-bright',
            sharingGroupId: null,
          },
        ],
      }),
    ).toThrow(/must name the same sharing group/)
  })

  it('rejects one sharing-group label applied to different material', () => {
    expect(() =>
      parseCastProposal({
        bookId: 'book-abc123',
        epubSha256: 'a'.repeat(64),
        assignments: [
          ...['amber', 'basil'].map((speaker) => ({
            speakerId: `speaker-${speaker}`,
            aliases: [speaker],
            materialProfileId: 'material-bright',
            sharingGroupId: 'minor-shared',
          })),
          ...['coral', 'dahlia'].map((speaker) => ({
            speakerId: `speaker-${speaker}`,
            aliases: [speaker],
            materialProfileId: 'material-low',
            sharingGroupId: 'minor-shared',
          })),
        ],
      }),
    ).toThrow(/cannot name more than one voice material/)
  })

  it('rejects material absent from the listening-evidence-backed inventory', async () => {
    const review = new ReviewCastApprovals({
      approvals: new InMemoryCastApprovals(),
      allowedMaterialProfileIds: ['material-bright'],
    })

    await expect(
      review.approve({ proposal: proposal(), decidedBy: 'Reviewer One' }),
    ).rejects.toThrow(/not in the approved production inventory/)
  })

  it('cannot create approval evidence without a resolved actor', () => {
    expect(() =>
      createCastApprovalRecord({
        ...proposal(),
        decidedBy: '   ',
        decidedAt: '2026-07-26T12:00:00.000Z',
      }),
    ).toThrow(DomainError)
  })

  it('rejects numeric or positional fields in the proposal wire shape', () => {
    expect(() =>
      parseCastProposal({
        bookId: 'book-abc123',
        epubSha256: 'a'.repeat(64),
        assignments: [],
        speakerCount: 3,
      }),
    ).toThrow(/unsupported shape/)
  })

  it('rejects a duplicate speaker assignment at approval time so an unrenderable cast cannot persist', async () => {
    const repository = new InMemoryCastApprovals()
    const review = new ReviewCastApprovals({
      approvals: repository,
      allowedMaterialProfileIds: [
        'material-bright',
        'material-low',
        'material-quiet',
        'material-soft',
      ],
    })
    // A proposal that names the same speaker twice would render as one voice in `VoiceCast` only after
    // every later run for this EPUB throws; approval must reject it before it is written to the ledger.
    // The duplicate sits in the MIDDLE of the four sorted assignments, not at either end: with only
    // two assignments (or a duplicate at an end) a `first === last` or `first-two` narrowing still
    // throws, so the whole roster is needed to force a full set-based uniqueness check.
    const duplicateSpeakerProposal: CastProposal = {
      bookId: 'book-abc123',
      epubSha256: 'a'.repeat(64),
      assignments: [
        {
          speakerId: 'speaker-amber',
          aliases: ['Amber'],
          materialProfileId: 'material-bright',
          sharingGroupId: null,
        },
        {
          speakerId: 'speaker-basil',
          aliases: ['Basil'],
          materialProfileId: 'material-low',
          sharingGroupId: null,
        },
        {
          speakerId: 'speaker-basil',
          aliases: ['Captain Basil'],
          materialProfileId: 'material-quiet',
          sharingGroupId: null,
        },
        {
          speakerId: 'speaker-coral',
          aliases: ['Coral'],
          materialProfileId: 'material-soft',
          sharingGroupId: null,
        },
      ],
    }

    await expect(
      review.approve({ proposal: duplicateSpeakerProposal, decidedBy: 'Reviewer One' }),
    ).rejects.toThrow(/more than once/)
    expect(repository.approval).toBeUndefined()
  })

  it('rejects an exclusive material claiming a sharing group, which would otherwise be invisible', async () => {
    // A lone sharing-group claim names no co-sharer, so sharedVoiceMaterialGroups (which only surfaces
    // material reused by two or more speakers) would hide it. Reject it at the proposal boundary.
    // Two exclusive materials are needed: with a single assignment the correct per-material scope
    // (`group.length === 1`) is indistinguishable from a proposal-wide scope (`assignments.length
    // === 1`), so the latter narrowing still throws and survives. One of the two groups carries the
    // lone sharing claim while the proposal as a whole has more than one assignment.
    const repository = new InMemoryCastApprovals()
    const review = new ReviewCastApprovals({
      approvals: repository,
      allowedMaterialProfileIds: ['material-bright', 'material-low'],
    })
    const exclusiveClaimingShared: CastProposal = {
      bookId: 'book-abc123',
      epubSha256: 'a'.repeat(64),
      assignments: [
        {
          speakerId: 'speaker-amber',
          aliases: ['Amber'],
          materialProfileId: 'material-bright',
          sharingGroupId: 'lone-claim',
        },
        {
          speakerId: 'speaker-basil',
          aliases: ['Basil'],
          materialProfileId: 'material-low',
          sharingGroupId: null,
        },
      ],
    }

    // The wire boundary rejects it before a typed proposal can be trusted...
    expect(() => parseCastProposal(exclusiveClaimingShared)).toThrow(/cannot claim to be shared/)
    // ...and the approval path therefore never persists an invisible cast.
    await expect(
      review.approve({ proposal: exclusiveClaimingShared, decidedBy: 'Reviewer One' }),
    ).rejects.toThrow(/cannot claim to be shared/)
    expect(repository.approval).toBeUndefined()
  })

  it('rejects a non-canonical decision time, guarding the persistence trust boundary', () => {
    // The use case always emits a canonical instant via Date#toISOString(), so this validator is not
    // reached on the happy approval path. It is still a live trust boundary, not a dead branch:
    // SqliteCastApprovalRepository reconstructs stored rows through createCastApprovalRecord in both
    // findCastApproval (on load) and saveCastApproval (on write), so a row whose decided_at was
    // poisoned to a valid-but-non-canonical value is rejected on reconstruction instead of trusted.
    // Pin canonical equality itself, not one spelling: several distinct non-canonical forms that are
    // all valid dates must each be rejected, so no single-character or length-only narrowing survives.
    let record: PersistedCastApproval | undefined
    // Missing milliseconds (length 20): parseable, carries T and Z, but not canonical. Kills the
    // must-contain-T and trailing-Z / ends-with-Z narrowings, which this form would otherwise satisfy.
    expect(() => {
      record = createCastApprovalRecord({
        ...proposal(),
        decidedBy: 'Reviewer One',
        decidedAt: '2026-07-26T12:00:00Z',
      })
    }).toThrow(/canonical ISO 8601/)
    expect(record).toBeUndefined()
    // Space instead of 'T' (length 24): parseable and the right length, but not canonical. Kills the
    // length === 24 narrowing, which the millisecond-less form above cannot catch on its own.
    expect(() => {
      record = createCastApprovalRecord({
        ...proposal(),
        decidedBy: 'Reviewer One',
        decidedAt: '2026-07-26 12:00:00.000Z',
      })
    }).toThrow(/canonical ISO 8601/)
    expect(record).toBeUndefined()
  })
})
