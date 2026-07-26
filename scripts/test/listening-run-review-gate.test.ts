import { spawn, spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const EPUB = path.join(REPOSITORY_ROOT, 'tests/fixtures/epub/acceptance-m1.epub')
const LISTENING_RUN = path.join(REPOSITORY_ROOT, 'scripts/listening-run.mjs')
const FFMPEG_DIRECTORY =
  process.env.LIGHT_NOVEL_AUDIOBOOK_FFMPEG_DIR ??
  path.join(homedir(), '.local/share/light-novel-audiobook/tools/ffmpeg/current')
const TOOLCHAIN_PRESENT = ['ffmpeg', 'ffprobe'].every(
  (name) => spawnSync('test', ['-x', path.join(FFMPEG_DIRECTORY, name)]).status === 0,
)
if (!TOOLCHAIN_PRESENT) {
  process.stderr.write(
    `[skipped] listening-run review-gate coverage needs pinned ffmpeg/ffprobe in ${FFMPEG_DIRECTORY}.\n`,
  )
}

interface CommandReceipt {
  readonly command: 'pipeline:demo' | 'pipeline:review'
  readonly action: 'run' | 'list' | 'approve'
  readonly segmentId: string | null
  readonly exitCode: number
}

interface LedgerState {
  readonly jobState: string
  readonly warningCount: number
  readonly approvals: readonly {
    readonly segmentId: string
    readonly fallbackReason: string
    readonly grantId: string | null
    readonly decidedBy: string
  }[]
  readonly grants: number
  readonly outputs: number
}

interface ListeningResult {
  readonly exitCode: number
  readonly output: string
  readonly workspace: string
  readonly commands: readonly CommandReceipt[]
  readonly ledger: LedgerState
}

const roots: string[] = []
const children = new Set<number>()

const realPnpm = (): string => {
  const result = spawnSync('which', ['pnpm'], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error('pnpm executable was not found')
  return result.stdout.trim()
}

const waitForExit = async (
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
  purpose: string,
): Promise<number> => {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (child.exitCode !== null) return child.exitCode
    if (child.signalCode !== null) return 1
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  throw new Error(`${purpose} did not exit within ${timeoutMs}ms`)
}

const readCommands = async (workspace: string): Promise<readonly CommandReceipt[]> =>
  (await readFile(path.join(workspace, 'listening-run-commands.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CommandReceipt)

const readLedger = (workspace: string, jobId: string): LedgerState => {
  const database = new DatabaseSync(path.join(workspace, 'audiobook.db'), { readOnly: true })
  try {
    const row = database.prepare('SELECT snapshot_json FROM jobs WHERE id = ?').get(jobId) as
      | { readonly snapshot_json: string }
      | undefined
    if (row === undefined) throw new Error('listening run did not persist its job')
    const snapshot = JSON.parse(row.snapshot_json) as {
      readonly state: string
      readonly warnings: readonly unknown[]
    }
    const approvals = database
      .prepare(
        `SELECT segment_id, fallback_reason, grant_id, decided_by
           FROM fallback_approvals ORDER BY segment_id`,
      )
      .all() as unknown as readonly {
      readonly segment_id: string
      readonly fallback_reason: string
      readonly grant_id: string | null
      readonly decided_by: string
    }[]
    return {
      jobState: snapshot.state,
      warningCount: snapshot.warnings.length,
      approvals: approvals.map((approval) => ({
        segmentId: approval.segment_id,
        fallbackReason: approval.fallback_reason,
        grantId: approval.grant_id,
        decidedBy: approval.decided_by,
      })),
      grants: Number(
        database.prepare('SELECT COUNT(*) AS count FROM fallback_book_grants').get().count,
      ),
      outputs: Number(
        database.prepare('SELECT COUNT(*) AS count FROM completed_outputs').get().count,
      ),
    }
  } finally {
    database.close()
  }
}

const runListening = async (
  fakeDirectorMode: 'unresolved-homogeneous' | 'fallback-heterogeneous',
  options: { readonly failApproval?: boolean } = {},
): Promise<ListeningResult> => {
  const root = await mkdtemp(path.join(tmpdir(), 'lna-listening-review-gate-'))
  roots.push(root)
  const workspace = path.join(root, 'workspace')
  const bin = path.join(root, 'bin')
  await Promise.all([mkdir(workspace), mkdir(bin)])
  const wrapper = path.join(bin, 'pnpm')
  await writeFile(
    wrapper,
    `#!/usr/bin/env node
import { spawn } from 'node:child_process'
const args = process.argv.slice(2)
if (
  process.env.LNA_TEST_FAIL_REVIEW_APPROVAL === '1' &&
  args[0] === 'pipeline:review' &&
  args[args.indexOf('--') + 1] === 'approve'
) {
  process.exit(72)
}
const child = spawn(process.env.LNA_TEST_REAL_PNPM, args, { stdio: 'inherit', env: process.env })
child.once('error', () => process.exit(71))
child.once('exit', (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
`,
  )
  await chmod(wrapper, 0o755)

  const jobId = `review-gate-${fakeDirectorMode}`
  const child = spawn(
    process.execPath,
    [
      LISTENING_RUN,
      '--epub',
      EPUB,
      '--workspace',
      workspace,
      '--job-id',
      jobId,
      '--chapters',
      '1',
      '--max-passages-per-chapter',
      '2',
      '--transports',
      'fake',
      '--reviewer',
      'review-gate-test',
    ],
    {
      cwd: REPOSITORY_ROOT,
      detached: true,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        LIGHT_NOVEL_AUDIOBOOK_FFMPEG_DIR: FFMPEG_DIRECTORY,
        LNA_FAKE_DIRECTOR_MODE: fakeDirectorMode,
        LNA_TEST_REAL_PNPM: realPnpm(),
        ...(options.failApproval ? { LNA_TEST_FAIL_REVIEW_APPROVAL: '1' } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  if (child.pid !== undefined) children.add(child.pid)
  let output = ''
  const append = (chunk: unknown): void => {
    output = `${output}${String(chunk)}`.slice(-16_000)
  }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  const exitCode = await waitForExit(child, 60_000, `${fakeDirectorMode} listening run`)
  if (child.pid !== undefined) children.delete(child.pid)

  return {
    exitCode,
    output,
    workspace,
    commands: await readCommands(workspace),
    ledger: readLedger(workspace, jobId),
  }
}

afterEach(async () => {
  for (const pid of children) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  children.clear()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const demoReceipts = (result: ListeningResult): readonly CommandReceipt[] =>
  result.commands.filter((receipt) => receipt.command === 'pipeline:demo')
const reviewReceipts = (result: ListeningResult): readonly CommandReceipt[] =>
  result.commands.filter((receipt) => receipt.command === 'pipeline:review')

describe.skipIf(!TOOLCHAIN_PRESENT)(
  'listening-run fallback review gate over fake transports',
  () => {
    it('observes a genuine stop, records one homogeneous book grant, and resumes', async () => {
      const result = await runListening('unresolved-homogeneous')

      expect(result.exitCode).toBe(0)
      expect(demoReceipts(result).map((receipt) => receipt.exitCode)).toEqual([1, 0])
      expect(
        reviewReceipts(result).map(({ action, segmentId, exitCode }) => ({
          action,
          segmentId,
          exitCode,
        })),
      ).toEqual([
        { action: 'list', segmentId: null, exitCode: 0 },
        { action: 'approve', segmentId: null, exitCode: 0 },
      ])
      expect(result.ledger).toMatchObject({
        jobState: 'completed',
        warningCount: 2,
        grants: 1,
        outputs: 1,
      })
      expect(result.ledger.approvals).toHaveLength(2)
      expect(result.ledger.approvals.every((approval) => approval.grantId !== null)).toBe(true)
      expect(
        result.ledger.approvals.every((approval) => approval.decidedBy === 'review-gate-test'),
      ).toBe(true)
    }, 90_000)

    it('takes the heterogeneous per-segment loop and persists every individual decision', async () => {
      const result = await runListening('fallback-heterogeneous')

      expect(result.exitCode).toBe(0)
      expect(demoReceipts(result).map((receipt) => receipt.exitCode)).toEqual([1, 0])
      const reviews = reviewReceipts(result)
      expect(reviews).toHaveLength(3)
      expect(reviews[0]).toMatchObject({ action: 'list', segmentId: null, exitCode: 0 })
      expect(reviews.slice(1).every((receipt) => receipt.action === 'approve')).toBe(true)
      expect(reviews.slice(1).every((receipt) => receipt.segmentId !== null)).toBe(true)
      expect(new Set(reviews.slice(1).map((receipt) => receipt.segmentId)).size).toBe(2)
      expect(result.ledger).toMatchObject({
        jobState: 'completed',
        warningCount: 2,
        grants: 0,
        outputs: 1,
      })
      expect(result.ledger.approvals).toHaveLength(2)
      expect(new Set(result.ledger.approvals.map((approval) => approval.fallbackReason)).size).toBe(
        2,
      )
      expect(result.ledger.approvals.every((approval) => approval.grantId === null)).toBe(true)
      expect(
        result.ledger.approvals.every((approval) => approval.decidedBy === 'review-gate-test'),
      ).toBe(true)
    }, 90_000)

    it('fails loudly with the driver log when the gate cannot be satisfied', async () => {
      const result = await runListening('unresolved-homogeneous', { failApproval: true })

      expect(result.exitCode).not.toBe(0)
      expect(result.output).toContain(
        `book-wide review approval failed; see ${result.workspace}/driver.log`,
      )
      expect(demoReceipts(result).map((receipt) => receipt.exitCode)).toEqual([1])
      expect(
        reviewReceipts(result).map(({ action, segmentId, exitCode }) => ({
          action,
          segmentId,
          exitCode,
        })),
      ).toEqual([
        { action: 'list', segmentId: null, exitCode: 0 },
        { action: 'approve', segmentId: null, exitCode: 72 },
      ])
      expect(result.ledger).toMatchObject({
        jobState: 'awaiting_review',
        warningCount: 2,
        approvals: [],
        grants: 0,
        outputs: 0,
      })
    }, 90_000)
  },
)
