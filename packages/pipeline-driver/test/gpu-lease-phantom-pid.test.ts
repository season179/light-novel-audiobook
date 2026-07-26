import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FileGpuLeaseCoordinator } from '@light-novel-audiobook/gpu-lease'
import { afterEach, describe, expect, it } from 'vitest'
import { createLivenessFilteringNvidiaSmi } from './helpers/liveness-filtering-nvidia-smi.js'

/**
 * #68: under WSL2/GPU-PV the nvidia-smi compute-apps table can list PIDs that are already dead,
 * reported as `[Not Found], [N/A]`, and the unfiltered foreign-process diagnostic failed an
 * otherwise correct test on exactly such a phantom. These tests run without a GPU: a fake
 * nvidia-smi injects the table, and the liveness-filtering wrapper is the fix under test. The
 * kernel flock and the coordinator's guard both stay real throughout.
 */

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeRoot(name: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `${name}-`))
  roots.push(root)
  return root
}

/** Stands in for nvidia-smi, answering the compute-app and total-memory queries separately. */
async function fakeNvidiaSmi(
  root: string,
  output: { computeApps: string; memoryUsedMiB: string },
): Promise<string> {
  const executable = path.join(root, 'fake-nvidia-smi')
  await writeFile(
    executable,
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
  return executable
}

/** A positive PID with no `/proc` entry: the shape of a phantom row from a stale table. */
function deadPid(): number {
  for (let pid = 400_000; pid < 4_000_000; pid += 1) {
    if (!existsSync(`/proc/${pid}`)) return pid
  }
  throw new Error('could not find an unused PID for the phantom row')
}

describe('GPU foreign-process guard behind the liveness filter (#68)', () => {
  it('does not trip on a dead phantom PID from a stale compute-apps table', async () => {
    const root = await makeRoot('gpu-phantom-pid')
    // Exactly what WSL2/GPU-PV reported in the issue: a real-looking PID, name and memory
    // unusable, and the PID itself already gone from /proc.
    const inner = await fakeNvidiaSmi(root, {
      computeApps: `${deadPid()}, [Not Found], [N/A]`,
      memoryUsedMiB: '231',
    })
    const nvidiaSmiExecutable = await createLivenessFilteringNvidiaSmi(root, inner)

    const lease = await new FileGpuLeaseCoordinator({
      lockFilePath: path.join(root, 'exclusive.lock'),
      nvidiaSmiExecutable,
    }).acquire('gemma')
    await lease.release()
  })

  it('still trips on a live uncoordinated PID the table reports', async () => {
    const root = await makeRoot('gpu-live-foreign-pid')
    // PID 1 is alive on any Linux host and never inside this process tree, so the guard must
    // treat it as a foreign compute process even after liveness filtering.
    const inner = await fakeNvidiaSmi(root, {
      computeApps: '1, [Not Found], [N/A]',
      memoryUsedMiB: '231',
    })
    const nvidiaSmiExecutable = await createLivenessFilteringNvidiaSmi(root, inner)
    const lockFilePath = path.join(root, 'exclusive.lock')

    await expect(
      new FileGpuLeaseCoordinator({ lockFilePath, nvidiaSmiExecutable }).acquire('gemma'),
    ).rejects.toMatchObject({
      code: 'diagnostic',
      message: expect.stringContaining('Uncoordinated GPU compute process'),
    })
    // A tripped guard must still free the kernel lease it had already taken.
    const lease = await new FileGpuLeaseCoordinator({
      lockFilePath,
      inspectExistingComputeProcesses: false,
    }).acquire('qwen3-tts')
    await lease.release()
  })

  it('keeps a row whose PID it cannot parse, failing closed on the unknown', async () => {
    const root = await makeRoot('gpu-unknown-row')
    // No parseable PID at all: the wrapper cannot prove anything about the row, so it must reach
    // the guard, and the guard must treat it as foreign rather than silently dropping it.
    const inner = await fakeNvidiaSmi(root, {
      computeApps: '[N/A], [Not Found], [N/A]',
      memoryUsedMiB: '231',
    })
    const nvidiaSmiExecutable = await createLivenessFilteringNvidiaSmi(root, inner)

    await expect(
      new FileGpuLeaseCoordinator({
        lockFilePath: path.join(root, 'exclusive.lock'),
        nvidiaSmiExecutable,
      }).acquire('gemma'),
    ).rejects.toMatchObject({
      code: 'diagnostic',
      message: expect.stringContaining('Uncoordinated GPU compute process'),
    })
  })
})
