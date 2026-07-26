import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, expect, it } from 'vitest'
import { FileGpuLeaseCoordinator } from '../../src/index.js'
import { reapOrphanedHolders, registerHolder } from '../fixture-reaper.js'

const phase = process.env.LNA_REAPER_PROBE_PHASE
const markerPath = process.env.LNA_REAPER_PROBE_MARKER

beforeAll(async () => {
  await reapOrphanedHolders()
})

it.skipIf(phase !== 'hold')(
  'holds a registered hostile flock subtree until worker SIGINT',
  async () => {
    if (markerPath === undefined) throw new Error('probe marker path is required')
    const nonce = `${process.pid}-${crypto.randomUUID()}`
    const root = join(tmpdir(), `gpu-lease-interrupt-holder-${nonce}`)
    const scriptsRoot = join(tmpdir(), `gpu-lease-interrupt-scripts-${nonce}`)
    const { mkdir } = await import('node:fs/promises')
    await Promise.all([mkdir(root, { recursive: true }), mkdir(scriptsRoot, { recursive: true })])
    const nested = join(scriptsRoot, 'holder.cjs')
    await writeFile(
      nested,
      [
        "process.stdout.write(process.argv[2] + '\\n')",
        'process.stdin.resume()',
        "process.on('SIGTERM', () => {})",
        "process.on('SIGHUP', () => {})",
        'setInterval(() => {}, 1_000)',
        '',
      ].join('\n'),
      { mode: 0o600 },
    )
    const flockExecutable = join(scriptsRoot, 'wedged-flock')
    await writeFile(
      flockExecutable,
      [
        '#!/bin/sh',
        `exec flock --exclusive --nonblock --conflict-exit-code 75 "$5" "$6" '${nested}' "$9"`,
        '',
      ].join('\n'),
      { mode: 0o700 },
    )

    let holderPgid: number | undefined
    const lockFilePath = join(root, 'exclusive.lock')
    await new FileGpuLeaseCoordinator({
      lockFilePath,
      flockExecutable,
      inspectExistingComputeProcesses: false,
      onHolderStarted: async (pgid) => {
        holderPgid = pgid
        await registerHolder(pgid, root)
      },
    }).acquire('gemma')
    if (holderPgid === undefined) throw new Error('holder was not registered')

    await expect(
      new FileGpuLeaseCoordinator({
        lockFilePath,
        inspectExistingComputeProcesses: false,
      }).acquire('qwen3-tts'),
    ).rejects.toMatchObject({ code: 'busy' })
    await writeFile(
      markerPath,
      JSON.stringify({ workerPid: process.pid, holderPgid, root, scriptsRoot }),
      'utf8',
    )
    await new Promise<void>(() => undefined)
  },
)

it.skipIf(phase !== 'verify')('startup reaps the interrupted holder before the test body', () => {
  const holderPgid = Number(process.env.LNA_REAPER_PROBE_HOLDER_PGID)
  expect(Number.isSafeInteger(holderPgid) && holderPgid > 1).toBe(true)
  expect(() => process.kill(-holderPgid, 0)).toThrow()
})
