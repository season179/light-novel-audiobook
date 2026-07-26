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
      allowedMaterialProfileIds: ['material-bright', 'material-low'],
    })
    // A proposal that names the same speaker twice would render as one voice in `VoiceCast` only after
    // every later run for this EPUB throws; approval must reject it before it is written to the ledger.
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
          speakerId: 'speaker-amber',
          aliases: ['Captain Amber'],
          materialProfileId: 'material-low',
          sharingGroupId: null,
        },
      ],
    }

    await expect(
      review.approve({ proposal: duplicateSpeakerProposal, decidedBy: 'Reviewer One' }),
    ).rejects.toThrow(/more than once/)
    expect(repository.approval).toBeUndefined()
  })
})
