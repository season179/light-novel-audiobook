import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, expect, it } from 'vitest'
import { FileGpuLeaseCoordinator } from '../../src/index.js'
import { loadRegistry, reapOrphanedHolders } from '../fixture-reaper.js'
import { hostileCoordinator } from '../hostile-coordinator.js'

const phase = process.env.LNA_REAPER_PROBE_PHASE
const probeDir = process.env.LNA_REAPER_PROBE_DIR
const nonce = process.env.LNA_REAPER_PROBE_NONCE

beforeAll(async () => {
  await reapOrphanedHolders()
})

it.skipIf(phase !== 'hold' && phase !== 'hold-pre')(
  'holds a registered hostile flock subtree until worker SIGINT',
  async () => {
    if (probeDir === undefined || nonce === undefined) {
      throw new Error('probe directory and nonce are required')
    }
    const root = join(tmpdir(), `gpu-lease-interrupt-holder-${nonce}`)
    const scriptsRoot = join(tmpdir(), `gpu-lease-interrupt-scripts-${nonce}`)
    await Promise.all([
      mkdir(root, { recursive: true }),
      mkdir(scriptsRoot, { recursive: true }),
      mkdir(probeDir, { recursive: true }),
    ])
    const startedPath = join(probeDir, 'started.json')
    const registeredPath = join(probeDir, 'registered.json')
    const violationPath = join(probeDir, 'ordering-violation.json')
    const gatePath = join(probeDir, 'token-gate')

    // The token gate keeps the handshake - and therefore `acquire()` - in flight until the outer
    // test has seen registration begin, so the interrupt lands at a point only in-acquisition
    // registration can survive.
    let holderPgid: number | undefined
    let registeredAt: number | undefined
    const lockFilePath = join(root, 'exclusive.lock')
    const coordinator = await hostileCoordinator({
      lockFilePath,
      scriptsRoot,
      gatePath,
      beforeRegister: async (pgid) => {
        holderPgid = pgid
        await writeFile(
          startedPath,
          JSON.stringify({ workerPid: process.pid, holderPgid: pgid, root, scriptsRoot }),
          'utf8',
        )
        if (phase === 'hold-pre') {
          // Blocked before durable registration: the outer probe delivers SIGINT here, inside
          // the pre-registration window. The holder must still be benign at this point, so the
          // interrupt EOFs it and leaves nothing unregistered behind.
          await new Promise<void>(() => undefined)
        }
      },
      afterRegister: async (pgid) => {
        registeredAt = performance.now()
        const registered = (await loadRegistry()).some((entry) => entry.holderPgid === pgid)
        await writeFile(
          registeredPath,
          JSON.stringify({
            workerPid: process.pid,
            holderPgid: pgid,
            root,
            scriptsRoot,
            registered,
            registeredAt,
          }),
          'utf8',
        )
      },
    })
    await coordinator.acquire('gemma')
    if (holderPgid === undefined) throw new Error('holder was not registered')
    if (registeredAt === undefined) {
      // `acquire()` returned while registration was still in flight (or never ran): the exact
      // ordering defect #67 pins. Publish the violation so the outer test fails on the real
      // cause rather than on a missing marker.
      await writeFile(
        violationPath,
        JSON.stringify({ reason: 'acquire returned before holder registration completed' }),
        'utf8',
      )
      throw new Error('acquire returned before holder registration completed')
    }

    await expect(
      new FileGpuLeaseCoordinator({
        lockFilePath,
        inspectExistingComputeProcesses: false,
      }).acquire('qwen3-tts'),
    ).rejects.toMatchObject({ code: 'busy' })
    await new Promise<void>(() => undefined)
  },
)

it.skipIf(phase !== 'verify')('startup reaps the interrupted holder before the test body', () => {
  const holderPgid = Number(process.env.LNA_REAPER_PROBE_HOLDER_PGID)
  expect(Number.isSafeInteger(holderPgid) && holderPgid > 1).toBe(true)
  expect(() => process.kill(-holderPgid, 0)).toThrow()
})
