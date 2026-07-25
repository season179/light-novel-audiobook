import { type ChildProcess, spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileGpuLeaseCoordinator } from '../src/index.js'

const roots: string[] = []
const children: ChildProcess[] = []

function coordinator(path: string): FileGpuLeaseCoordinator {
  return new FileGpuLeaseCoordinator({ lockFilePath: path, inspectExistingComputeProcesses: false })
}

async function makeRoot(name: string): Promise<string> {
  const root = join(tmpdir(), `${name}-${crypto.randomUUID()}`)
  roots.push(root)
  await mkdir(root, { recursive: true })
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

/**
 * Stands in for flock with a holder that survives stdin end and SIGTERM, so release must escalate
 * to SIGKILL. `$9` is the token the coordinator appends to the holder argv.
 */
async function fakeStubbornFlock(root: string, body: string): Promise<string> {
  const path = join(root, 'fake-flock')
  await writeFile(
    path,
    ['#!/bin/sh', body, "trap '' TERM", 'while true; do sleep 1; done', ''].join('\n'),
    {
      mode: 0o700,
    },
  )
  return path
}

/** A live process inside this test's process tree, standing in for our own llama.cpp server. */
function spawnOwnedChild(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
    stdio: 'ignore',
  })
  children.push(child)
  return child
}

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe('FileGpuLeaseCoordinator', () => {
  it('uses one kernel flock contract for Gemma and Qwen and releases without unlinking', async () => {
    const root = await makeRoot('gpu-flock')
    const path = join(root, 'exclusive.lock')
    const gemma = coordinator(path)
    const qwen = coordinator(path)

    const gemmaLease = await gemma.acquire('gemma')
    await expect(qwen.acquire('qwen3-tts')).rejects.toMatchObject({ code: 'busy' })
    await gemmaLease.release()

    const qwenLease = await qwen.acquire('qwen3-tts')
    expect(qwenLease.lockFilePath).toBe(path)
    await qwenLease.release()
  })

  it('treats nvidia-smi as a post-lock diagnostic and releases after a diagnostic failure', async () => {
    const root = await makeRoot('gpu-flock-diagnostic')
    const path = join(root, 'exclusive.lock')
    const diagnostic = new FileGpuLeaseCoordinator({
      lockFilePath: path,
      nvidiaSmiExecutable: '/bin/echo',
    })

    await expect(diagnostic.acquire('qwen3-tts')).rejects.toMatchObject({ code: 'diagnostic' })
    const lease = await coordinator(path).acquire('composition')
    await lease.release()
  })

  it('cancels acquisition while another process owns the kernel lease', async () => {
    const root = await makeRoot('gpu-flock-cancel')
    const path = join(root, 'exclusive.lock')
    const first = await coordinator(path).acquire('gemma')
    const controller = new AbortController()
    controller.abort()

    await expect(coordinator(path).acquire('qwen3-tts', controller.signal)).rejects.toMatchObject({
      code: 'cancelled',
    })
    await first.release()
  })

  it('runs the production default inspection and excludes this process tree by PID', async () => {
    const root = await makeRoot('gpu-flock-self')
    const path = join(root, 'exclusive.lock')
    const owned = spawnOwnedChild()
    // Exactly what WSL2/GPU-PV reports: a real PID with an unusable name and per-process memory.
    const nvidiaSmiExecutable = await fakeNvidiaSmi(root, {
      computeApps: `${owned.pid}, [Not Found], [N/A]`,
      memoryUsedMiB: '14400',
    })

    const lease = await new FileGpuLeaseCoordinator({
      lockFilePath: path,
      nvidiaSmiExecutable,
    }).acquire('gemma')
    expect(lease.lockFilePath).toBe(path)
    await lease.release()
  })

  it('rejects a foreign compute process under the production default and frees the lock', async () => {
    const root = await makeRoot('gpu-flock-foreign')
    const path = join(root, 'exclusive.lock')
    const nvidiaSmiExecutable = await fakeNvidiaSmi(root, {
      computeApps: '1, [Not Found], [N/A]',
      memoryUsedMiB: '231',
    })

    await expect(
      new FileGpuLeaseCoordinator({ lockFilePath: path, nvidiaSmiExecutable }).acquire('gemma'),
    ).rejects.toMatchObject({ code: 'diagnostic' })
    const lease = await coordinator(path).acquire('qwen3-tts')
    await lease.release()
  })

  it('rejects unattributed GPU residency above the threshold and allows the idle baseline', async () => {
    const root = await makeRoot('gpu-flock-residency')
    const path = join(root, 'exclusive.lock')
    const loaded = await fakeNvidiaSmi(root, { computeApps: '', memoryUsedMiB: '2007' })
    await expect(
      new FileGpuLeaseCoordinator({
        lockFilePath: path,
        nvidiaSmiExecutable: loaded,
      }).acquire('gemma'),
    ).rejects.toMatchObject({ code: 'diagnostic' })

    const idleRoot = await makeRoot('gpu-flock-residency-idle')
    const idle = await fakeNvidiaSmi(idleRoot, { computeApps: '', memoryUsedMiB: '231' })
    const lease = await new FileGpuLeaseCoordinator({
      lockFilePath: path,
      nvidiaSmiExecutable: idle,
    }).acquire('gemma')
    await lease.release()
  })

  it('reports the diagnostic cause even when stopping the holder needs SIGKILL', async () => {
    const root = await makeRoot('gpu-flock-cause')
    const path = join(root, 'exclusive.lock')
    const flockExecutable = await fakeStubbornFlock(root, `printf '%s\\n' "$9"`)
    const nvidiaSmiExecutable = await fakeNvidiaSmi(root, {
      computeApps: '1, [Not Found], [N/A]',
      memoryUsedMiB: '231',
    })

    await expect(
      new FileGpuLeaseCoordinator({
        lockFilePath: path,
        flockExecutable,
        nvidiaSmiExecutable,
        releaseGraceMs: 200,
      }).acquire('gemma'),
    ).rejects.toMatchObject({
      code: 'diagnostic',
      message: expect.stringContaining('Uncoordinated GPU compute process'),
    })
  })

  it('stops a holder whose handshake is unusable instead of waiting on a live process', async () => {
    const root = await makeRoot('gpu-flock-unusable')
    const path = join(root, 'exclusive.lock')
    const flockExecutable = await fakeStubbornFlock(
      root,
      // Comfortably past the 4 KB handshake ceiling without ever printing the token.
      'i=0; while [ $i -lt 400 ]; do printf "not-the-token-%s\\n" "$i"; i=$((i+1)); done',
    )

    await expect(
      new FileGpuLeaseCoordinator({
        lockFilePath: path,
        flockExecutable,
        inspectExistingComputeProcesses: false,
        releaseGraceMs: 200,
      }).acquire('gemma'),
    ).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringContaining('unusable handshake'),
    })
  }, 10_000)

  it('never treats an unreadable memory reading as zero usage', async () => {
    const root = await makeRoot('gpu-flock-unknown-memory')
    const path = join(root, 'exclusive.lock')
    const nvidiaSmiExecutable = await fakeNvidiaSmi(root, {
      computeApps: '',
      memoryUsedMiB: '[N/A]',
    })

    const lease = await new FileGpuLeaseCoordinator({
      lockFilePath: path,
      nvidiaSmiExecutable,
      residentGpuMemoryThresholdMiB: 512,
    }).acquire('gemma')
    await lease.release()
  })
})
