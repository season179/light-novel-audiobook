import { createHash } from 'node:crypto'
import { DomainError } from '@light-novel-audiobook/domain'
import { normalizeReviewerIdentity } from './reviewer-identity.js'

const SHA256 = /^[a-f\d]{64}$/i
const SIMPLE_ID = /^[a-z\d](?:[a-z\d._:-]*[a-z\d])?$/i
const MAX_ALIAS_LENGTH = 256

export interface CastAssignment {
  readonly speakerId: string
  readonly aliases: readonly string[]
  /** ID of material already admitted by the pinned production voice inventory. */
  readonly materialProfileId: string
  /** Required on every member of a reused-material group; forbidden for exclusive material. */
  readonly sharingGroupId: string | null
}

/** Model output is only a proposal. It deliberately contains no actor or approval fields. */
export interface CastProposal {
  readonly bookId: string
  readonly epubSha256: string
  readonly assignments: readonly CastAssignment[]
}

export interface CastApprovalDecision extends CastProposal {
  readonly decidedBy: string
  readonly decidedAt: string
}

export interface PersistedCastApproval extends CastApprovalDecision {
  readonly approvalId: string
  readonly approvalSha256: string
}

export interface SharedVoiceMaterialGroup {
  readonly sharingGroupId: string
  readonly materialProfileId: string
  readonly speakerIds: readonly string[]
}

/**
 * Parses an external proposal without granting it authority. No source offsets, positions, counts, or
 * other numeric model claims exist in this wire shape: only stable speakers, aliases, and material.
 */
export const parseCastProposal = (input: unknown): CastProposal => {
  const object = strictObject(input, ['bookId', 'epubSha256', 'assignments'], 'cast proposal')
  if (!Array.isArray(object.assignments)) {
    throw new DomainError('A cast proposal requires an assignments array')
  }
  return canonicalProposal({
    bookId: stringField(object.bookId, 'bookId'),
    epubSha256: stringField(object.epubSha256, 'epubSha256'),
    assignments: object.assignments.map((assignment, index) => {
      const item = strictObject(
        assignment,
        ['speakerId', 'aliases', 'materialProfileId', 'sharingGroupId'],
        `cast assignment ${index + 1}`,
      )
      if (!Array.isArray(item.aliases)) {
        throw new DomainError(`Cast assignment ${index + 1} requires an aliases array`)
      }
      if (item.sharingGroupId !== null && typeof item.sharingGroupId !== 'string') {
        throw new DomainError(`Cast assignment ${index + 1} has an invalid sharing group`)
      }
      return {
        speakerId: stringField(item.speakerId, 'speakerId'),
        aliases: item.aliases.map((alias) => stringField(alias, 'alias')),
        materialProfileId: stringField(item.materialProfileId, 'materialProfileId'),
        sharingGroupId: item.sharingGroupId,
      }
    }),
  })
}

/** Canonical content-addressed evidence of one actor-attributed cast decision. */
export const createCastApprovalRecord = (decision: CastApprovalDecision): PersistedCastApproval => {
  const proposal = canonicalProposal(decision)
  validateActor(decision.decidedBy)
  validateDecidedAt(decision.decidedAt)
  const canonicalDecision: CastApprovalDecision = {
    ...proposal,
    decidedBy: decision.decidedBy.trim(),
    decidedAt: decision.decidedAt,
  }
  const approvalSha256 = createHash('sha256')
    .update(JSON.stringify({ schema: 'cast-approval@1', ...canonicalDecision }), 'utf8')
    .digest('hex')
  return Object.freeze({
    ...canonicalDecision,
    approvalId: `cast-${approvalSha256.slice(0, 24)}`,
    approvalSha256,
  })
}

/** Sharing groups shown to the human before approval; an empty result means all material is exclusive. */
export const sharedVoiceMaterialGroups = (
  assignments: readonly CastAssignment[],
): readonly SharedVoiceMaterialGroup[] => {
  const byMaterial = new Map<string, CastAssignment[]>()
  for (const assignment of assignments) {
    const group = byMaterial.get(assignment.materialProfileId) ?? []
    group.push(assignment)
    byMaterial.set(assignment.materialProfileId, group)
  }
  return Object.freeze(
    [...byMaterial.entries()]
      .filter(([, group]) => group.length > 1)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([materialProfileId, group]) =>
        Object.freeze({
          sharingGroupId: group[0]?.sharingGroupId as string,
          materialProfileId,
          speakerIds: Object.freeze(group.map((item) => item.speakerId).sort()),
        }),
      ),
  )
}

const canonicalProposal = (proposal: CastProposal): CastProposal => {
  if (!SIMPLE_ID.test(proposal.bookId))
    throw new DomainError('A cast proposal requires a stable book ID')
  if (!SHA256.test(proposal.epubSha256)) {
    throw new DomainError('A cast proposal requires the EPUB SHA-256')
  }
  if (proposal.assignments.length === 0) {
    throw new DomainError('A cast proposal requires at least one character assignment')
  }

  const assignments = proposal.assignments
    .map((assignment): CastAssignment => {
      if (!SIMPLE_ID.test(assignment.speakerId)) {
        throw new DomainError(
          `Cast speaker ${JSON.stringify(assignment.speakerId)} is not a stable ID`,
        )
      }
      if (!SIMPLE_ID.test(assignment.materialProfileId)) {
        throw new DomainError(
          `Cast material ${JSON.stringify(assignment.materialProfileId)} is not a stable ID`,
        )
      }
      if (assignment.sharingGroupId !== null && !SIMPLE_ID.test(assignment.sharingGroupId)) {
        throw new DomainError('A shared cast assignment requires a stable sharing group ID')
      }
      const aliases = assignment.aliases.map((alias) => alias.trim()).sort()
      if (
        aliases.some(
          (alias) =>
            alias.length === 0 ||
            alias.length > MAX_ALIAS_LENGTH ||
            [...alias].some((character) => (character.codePointAt(0) ?? 0) < 0x20),
        ) ||
        new Set(aliases).size !== aliases.length
      ) {
        throw new DomainError(
          `Cast speaker ${assignment.speakerId} has invalid or duplicate aliases`,
        )
      }
      return Object.freeze({
        speakerId: assignment.speakerId,
        aliases: Object.freeze(aliases),
        materialProfileId: assignment.materialProfileId,
        sharingGroupId: assignment.sharingGroupId,
      })
    })
    .sort((left, right) => left.speakerId.localeCompare(right.speakerId))

  if (new Set(assignments.map((item) => item.speakerId)).size !== assignments.length) {
    throw new DomainError('A cast proposal cannot assign one speaker more than once')
  }

  const byMaterial = new Map<string, CastAssignment[]>()
  const materialBySharingGroup = new Map<string, string>()
  for (const assignment of assignments) {
    const group = byMaterial.get(assignment.materialProfileId) ?? []
    group.push(assignment)
    byMaterial.set(assignment.materialProfileId, group)
    if (assignment.sharingGroupId !== null) {
      const groupedMaterial = materialBySharingGroup.get(assignment.sharingGroupId)
      if (groupedMaterial !== undefined && groupedMaterial !== assignment.materialProfileId) {
        throw new DomainError(
          `Cast sharing group ${assignment.sharingGroupId} cannot name more than one voice material`,
        )
      }
      materialBySharingGroup.set(assignment.sharingGroupId, assignment.materialProfileId)
    }
  }
  for (const [materialProfileId, group] of byMaterial) {
    const sharingIds = new Set(group.map((item) => item.sharingGroupId))
    if (group.length === 1 && group[0]?.sharingGroupId !== null) {
      throw new DomainError(
        `Exclusive cast material ${materialProfileId} cannot claim to be shared`,
      )
    }
    if (group.length > 1 && (sharingIds.size !== 1 || sharingIds.has(null))) {
      throw new DomainError(
        `Every speaker reusing cast material ${materialProfileId} must name the same sharing group`,
      )
    }
  }

  return Object.freeze({
    bookId: proposal.bookId,
    epubSha256: proposal.epubSha256.toLowerCase(),
    assignments: Object.freeze(assignments),
  })
}

const validateActor = (actor: string): void => {
  const normalized = normalizeReviewerIdentity(actor)
  if (normalized === undefined || normalized !== actor) {
    throw new DomainError('A cast approval requires a valid actor without control characters')
  }
}

const validateDecidedAt = (decidedAt: string): void => {
  if (
    decidedAt.length === 0 ||
    Number.isNaN(Date.parse(decidedAt)) ||
    new Date(decidedAt).toISOString() !== decidedAt
  ) {
    throw new DomainError('A cast approval requires a canonical ISO 8601 decision time')
  }
}

const strictObject = (
  input: unknown,
  keys: readonly string[],
  name: string,
): Record<string, unknown> => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new DomainError(`${name} must be an object`)
  }
  const object = input as Record<string, unknown>
  const expected = new Set(keys)
  if (
    Object.keys(object).some((key) => !expected.has(key)) ||
    keys.some((key) => !(key in object))
  ) {
    throw new DomainError(`${name} has an unsupported shape`)
  }
  return object
}

const stringField = (input: unknown, name: string): string => {
  if (typeof input !== 'string') throw new DomainError(`Cast ${name} must be a string`)
  return input
}
