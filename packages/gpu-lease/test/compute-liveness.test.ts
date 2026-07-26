// #68: under WSL2/GPU-PV the nvidia-smi compute-apps table can list PIDs that are already dead,
// reported as `[Not Found], [N/A]`. The liveness decision lives inside the coordinator's
// production diagnostic, so these tests construct the coordinator the way production does -
// defaults only - and inject nothing but the table itself.
//
// On the injected seam: `nvidiaSmiExecutable` is a production config option (not a test-only
// door), and it is used here solely to reproduce the GPU-PV table shape, which no host without a
// GPU can produce. The logic under test - parse, liveness probe against real `/proc`, tri-state
// classification, foreign-process guard - runs entirely in production code with
// `inspectExistingComputeProcesses` at its production default and the kernel flock real.

import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  classifyComputeApp,
  FileGpuLeaseCoordinator,
  livenessFromProcStat,
  probeProcessLiveness,
} from '../src/index.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `${name}-`))
  roots.push(root)
  return root
}

/** Stands in for nvidia-smi, answering the compute-app and total-memory queries separately. */
async function fakeNvidiaSmi(
  root: string,
  output: { computeApps: string; memoryUsedMiB: string },
): Promise<string> {
  const path = join(root, 'fake-nvidia-smi')
  await writeFile(
    path,
    [
      '#!/bin/sh',
      'case "$1" in',
      `  --query-compute-apps=*) printf '%s' '${output.computeApps}' ;;`,
      `  --query-gpu=*) printf '%s' '${output.memoryUsedMiB}' ;;`,
      '  *) exit 2 ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o700 },
  )
  return path
}

/** A positive PID with no `/proc` entry: the shape of a phantom row from a stale table. */
function deadPid(): number {
  for (let pid = 400_000; pid < 4_000_000; pid += 1) {
    if (!existsSync(`/proc/${pid}`)) return pid
  }
  throw new Error('could not find an unused PID for the phantom row')
}

describe('foreign-process guard liveness on the production acquire path (#68)', () => {
  it('does not fail a production-default acquire on a provably-dead phantom row', async () => {
    const root = await makeRoot('gpu-lease-phantom')
    // Exactly what WSL2/GPU-PV reported in the issue: a real-looking PID, name and memory
    // unusable, and the PID itself already gone from /proc.
    const nvidiaSmiExecutable = await fakeNvidiaSmi(root, {
      computeApps: `${deadPid()}, [Not Found], [N/A]`,
      memoryUsedMiB: '231',
    })

    // Constructed the way transports.ts constructs it, plus only the table: defaults for
    // everything else, so the guard and its liveness decision are the production ones.
    const lease = await new FileGpuLeaseCoordinator({
      lockFilePath: join(root, 'exclusive.lock'),
      nvidiaSmiExecutable,
    }).acquire('gemma')
    await lease.release()
  })

  it('still trips on a live uncoordinated row, and frees the lock it took', async () => {
    const root = await makeRoot('gpu-lease-live-foreign')
    // PID 1 is alive on any Linux host and never inside this process tree - the same shape as a
    // phantom PID that has been recycled by a different live process.
    const lockFilePath = join(root, 'exclusive.lock')
    const nvidiaSmiExecutable = await fakeNvidiaSmi(root, {
      computeApps: '1, [Not Found], [N/A]',
      memoryUsedMiB: '231',
    })

    await expect(
      new FileGpuLeaseCoordinator({ lockFilePath, nvidiaSmiExecutable }).acquire('gemma'),
    ).rejects.toMatchObject({
      code: 'diagnostic',
      message: expect.stringContaining('Uncoordinated GPU compute process'),
    })
    const lease = await new FileGpuLeaseCoordinator({
      lockFilePath,
      inspectExistingComputeProcesses: false,
    }).acquire('qwen3-tts')
    await lease.release()
  })

  it('checks every row, not just the first', async () => {
    const root = await makeRoot('gpu-lease-every-row')
    const lockFilePath = join(root, 'exclusive.lock')
    // The phantom first: a guard that examines only the first row would never see the live one.
    const phantomFirst = await fakeNvidiaSmi(root, {
      computeApps: `${deadPid()}, [Not Found], [N/A]\n1, [Not Found], [N/A]`,
      memoryUsedMiB: '231',
    })
    await expect(
      new FileGpuLeaseCoordinator({ lockFilePath, nvidiaSmiExecutable: phantomFirst }).acquire(
        'gemma',
      ),
    ).rejects.toMatchObject({ code: 'diagnostic' })

    const liveFirst = await fakeNvidiaSmi(root, {
      computeApps: `1, [Not Found], [N/A]\n${deadPid()}, [Not Found], [N/A]`,
      memoryUsedMiB: '231',
    })
    await expect(
      new FileGpuLeaseCoordinator({ lockFilePath, nvidiaSmiExecutable: liveFirst }).acquire(
        'gemma',
      ),
    ).rejects.toMatchObject({ code: 'diagnostic' })
  })

  it('keeps a row whose PID it cannot parse, failing closed on the unknown', async () => {
    const root = await makeRoot('gpu-lease-unparseable-row')
    const nvidiaSmiExecutable = await fakeNvidiaSmi(root, {
      computeApps: '[N/A], [Not Found], [N/A]',
      memoryUsedMiB: '231',
    })

    await expect(
      new FileGpuLeaseCoordinator({
        lockFilePath: join(root, 'exclusive.lock'),
        nvidiaSmiExecutable,
      }).acquire('gemma'),
    ).rejects.toMatchObject({
      code: 'diagnostic',
      message: expect.stringContaining('Uncoordinated GPU compute process'),
    })
  })
})

describe('livenessFromProcStat (#68)', () => {
  it('maps a vanished /proc entry (ENOENT) to dead', () => {
    expect(livenessFromProcStat({ ok: false, code: 'ENOENT' })).toBe('dead')
  })

  it.each(['EACCES', 'EPERM', 'EIO', 'ENAMETOOLONG', 'EFAULT', undefined])(
    'maps any non-ENOENT /proc failure (%s) to unknown, never dead',
    (code) => {
      expect(livenessFromProcStat({ ok: false, code })).toBe('unknown')
    },
  )

  it('maps a zombie or dead task state to dead', () => {
    expect(livenessFromProcStat({ ok: true, stat: '123 (node) Z 1 2 3\n' })).toBe('dead')
    expect(livenessFromProcStat({ ok: true, stat: '123 (node) X 1 2 3\n' })).toBe('dead')
  })

  it('maps any other task state to alive, tolerating spaces and parens in comm', () => {
    expect(livenessFromProcStat({ ok: true, stat: '123 (weird (comm) name) S 1 2 3\n' })).toBe(
      'alive',
    )
    expect(livenessFromProcStat({ ok: true, stat: '123 (node) R 1 2 3\n' })).toBe('alive')
    expect(livenessFromProcStat({ ok: true, stat: '123 (node) D 1 2 3\n' })).toBe('alive')
  })

  it('maps stat content it cannot parse to unknown, never dead', () => {
    expect(livenessFromProcStat({ ok: true, stat: 'no closing paren\n' })).toBe('unknown')
    expect(livenessFromProcStat({ ok: true, stat: '123 (node)\n' })).toBe('unknown')
  })
})

describe('probeProcessLiveness (#68)', () => {
  it('reads real /proc: this process is alive, an unused pid is dead', async () => {
    expect(await probeProcessLiveness(process.pid)).toBe('alive')
    expect(await probeProcessLiveness(deadPid())).toBe('dead')
  })

  it.each(['ENOENT'] as const)('maps %s to dead through the async probe', async (code) => {
    const reader = async (): Promise<string> => {
      throw Object.assign(new Error(`injected ${code}`), { code })
    }
    expect(await probeProcessLiveness(123_456, reader)).toBe('dead')
  })

  it.each(['EACCES', 'EPERM', 'EIO', 'ENAMETOOLONG', 'EFAULT'] as const)(
    'maps %s to unknown through the async probe',
    async (code) => {
      const reader = async (): Promise<string> => {
        throw Object.assign(new Error(`injected ${code}`), { code })
      }
      expect(await probeProcessLiveness(123_456, reader)).toBe('unknown')
    },
  )
})

describe('classifyComputeApp (#68)', () => {
  it('treats an unparseable row as foreign', async () => {
    expect(await classifyComputeApp({ pid: undefined, line: '[N/A], [Not Found], [N/A]' })).toBe(
      'foreign',
    )
  })

  it('treats a provably-dead row as a phantom', async () => {
    const verdict = await classifyComputeApp(
      { pid: 123_456, line: '123456, [Not Found], [N/A]' },
      async () => 'dead',
    )
    expect(verdict).toBe('phantom')
  })

  it('treats an unknown row as foreign, never as a phantom', async () => {
    // The fail-closed asymmetry: "cannot tell" must keep the guard tripping, because the cost of
    // a false dead is two models co-resident on one card.
    const verdict = await classifyComputeApp(
      { pid: 123_456, line: '123456, [Not Found], [N/A]' },
      async () => 'unknown',
    )
    expect(verdict).toBe('foreign')
  })

  it('treats a live row outside this process tree as foreign, and our own as ours', async () => {
    const alive = async (): Promise<'alive'> => 'alive'
    expect(await classifyComputeApp({ pid: 1, line: '1, [Not Found], [N/A]' }, alive)).toBe(
      'foreign',
    )
    expect(
      await classifyComputeApp({ pid: process.pid, line: `${process.pid}, node, 231` }, alive),
    ).toBe('own')
  })
})
