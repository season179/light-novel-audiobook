import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  characterSharesFallbackMaterial,
  parseCastProposal,
  ReviewCastApprovals,
  resolveReviewerIdentity,
  sharedVoiceMaterialGroups,
} from '@light-novel-audiobook/application'
import {
  layoutFor,
  migrateSchema,
  openWorkspace,
  SqliteCastApprovalRepository,
} from '@light-novel-audiobook/persistence'
import { loadProductionConfig } from '@light-novel-audiobook/qwen-tts'

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

const flag = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const requiredAbsolute = (name: string): string => {
  const value = flag(name)
  if (value === undefined || value.length === 0) throw new Error(`--${name} is required`)
  if (!path.isAbsolute(value)) throw new Error(`--${name} must be an absolute path`)
  return path.resolve(value)
}

const workspaceRoot = requiredAbsolute('workspace')
const proposalPath = requiredAbsolute('proposal')
const proposal = parseCastProposal(JSON.parse(await readFile(proposalPath, 'utf8')) as unknown)
const production = await loadProductionConfig(
  path.join(REPOSITORY_ROOT, 'config/qwen3-tts-production.json'),
)
const allowedMaterialProfileIds = production.value.voiceProfiles
  .filter((profile) => profile.role !== 'narrator')
  .map((profile) => profile.id)
const database = openWorkspace(layoutFor(workspaceRoot))

try {
  migrateSchema(database)
  const review = new ReviewCastApprovals({
    approvals: new SqliteCastApprovalRepository(database),
    allowedMaterialProfileIds,
  })
  const approval = await review.approve({
    proposal,
    decidedBy: resolveReviewerIdentity(),
  })
  const sharedGroups = sharedVoiceMaterialGroups(approval.assignments)
  // Deliberately text-free: real aliases and speaker IDs stay in the gitignored workspace ledger.
  process.stdout.write(
    `${JSON.stringify(
      {
        approvalId: approval.approvalId,
        approvalSha256: approval.approvalSha256,
        characterCount: approval.assignments.length,
        distinctMaterialCount: new Set(
          approval.assignments.map((assignment) => assignment.materialProfileId),
        ).size,
        sharedMaterialGroupCount: sharedGroups.length,
        characterSharesFallbackMaterial: characterSharesFallbackMaterial(
          production.value.fallbackVoiceProfileId,
          approval.assignments,
        ),
        decidedBy: approval.decidedBy,
        decidedAt: approval.decidedAt,
      },
      null,
      2,
    )}\n`,
  )
} finally {
  database.close()
}
