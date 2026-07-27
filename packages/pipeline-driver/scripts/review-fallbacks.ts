#!/usr/bin/env node
/**
 * Explicit human review for a pipeline-driver SQLite job.
 *
 *   pnpm pipeline:review -- list --workspace <path> --job-id <id>
 *   LNA_REVIEWER="Name" pnpm pipeline:review -- approve --workspace <path> --job-id <id>
 *   LNA_REVIEWER="Name" pnpm pipeline:review -- approve --workspace <path> --job-id <id> --segment-id <id>
 *   LNA_REVIEWER="Name" pnpm pipeline:review -- approve --workspace <path> --job-id <id> --segment-ids <id,id,...>
 *
 * `approve` is deliberately a separate invocation from rendering. Without a segment flag it records
 * a book-wide grant for one homogeneous decision group. With `--segment-id` it makes one segment
 * decision and clears any earlier withdrawal. With `--segment-ids` it makes one exact-set decision
 * over the listed pending segments, rejecting the whole set if any ID is no longer pending.
 */
import path from 'node:path'
import {
  type FallbackReviewApprovalNotice,
  runFallbackReviewCommand,
} from '../src/fallback-review-cli.js'

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

function required(name: string): string {
  const value = flag(name)
  if (value === undefined || value.trim().length === 0) throw new Error(`--${name} is required`)
  return value
}

const positional = process.argv.slice(2)
if (positional[0] === '--') positional.shift()
const action = positional[0]
if (action !== 'list' && action !== 'approve') {
  throw new Error('First argument must be the explicit review action: list or approve')
}

const printNotice = (notice: FallbackReviewApprovalNotice): void => {
  process.stdout.write(
    `${JSON.stringify({
      status: 'approving',
      actor: notice.actor,
      jobId: notice.jobId,
      decision: notice.decision,
      pendingCount: notice.items.length,
    })}\n`,
  )
  for (const item of notice.items) {
    process.stdout.write(`${JSON.stringify({ status: 'approving-item', ...item })}\n`)
  }
}

const report = await runFallbackReviewCommand({
  action,
  workspaceRoot: path.resolve(required('workspace')),
  jobId: required('job-id'),
  ...(action === 'approve'
    ? {
        announceApproval: printNotice,
        segmentId: flag('segment-id'),
        ...(flag('segment-ids') === undefined
          ? {}
          : { segmentIds: (flag('segment-ids') ?? '').split(',') }),
      }
    : {}),
})

if (report.action === 'list') {
  process.stdout.write(
    `${JSON.stringify({
      status: 'pending-fallback-review',
      jobId: report.jobId,
      pendingCount: report.pendingCount,
      excludedCount: report.excludedCount,
    })}\n`,
  )
  for (const item of report.items) {
    const status = item.decision === 'excluded' ? 'excluded-item' : 'pending-item'
    process.stdout.write(`${JSON.stringify({ status, ...item })}\n`)
  }
} else {
  process.stdout.write(
    `${JSON.stringify({
      status: 'approved',
      jobId: report.jobId,
      actor: report.actor,
      scope: report.scope,
      approvedCount: report.approvedCount,
      remainingReviewCount: report.remainingReviewCount,
      grantId: report.grantId,
      approvalId: report.approvalId,
    })}\n`,
  )
}
