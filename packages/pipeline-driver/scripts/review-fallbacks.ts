#!/usr/bin/env node
/**
 * Explicit human review for a pipeline-driver SQLite job.
 *
 *   pnpm pipeline:review -- list --workspace <path> --job-id <id>
 *   LNA_REVIEWER="Name" pnpm pipeline:review -- approve --workspace <path> --job-id <id>
 *
 * `approve` is deliberately a separate invocation from rendering. It records one attributed
 * book-wide grant and one content-bound approval per pending segment; generation never calls this.
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

const action = process.argv[2]
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
  ...(action === 'approve' ? { announceApproval: printNotice } : {}),
})

if (report.action === 'list') {
  process.stdout.write(
    `${JSON.stringify({
      status: 'pending-fallback-review',
      jobId: report.jobId,
      pendingCount: report.pendingCount,
    })}\n`,
  )
  for (const item of report.items) {
    process.stdout.write(`${JSON.stringify({ status: 'pending-item', ...item })}\n`)
  }
} else {
  process.stdout.write(
    `${JSON.stringify({
      status: 'approved',
      jobId: report.jobId,
      actor: report.actor,
      approvedCount: report.approvedCount,
      grantId: report.grantId,
    })}\n`,
  )
}
