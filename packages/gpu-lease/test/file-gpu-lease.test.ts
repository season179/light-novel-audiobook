import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileGpuLeaseCoordinator } from '../src/index.js'

const roots: string[] = []

function coordinator(path: string): FileGpuLeaseCoordinator {
  return new FileGpuLeaseCoordinator({ lockFilePath: path, inspectExistingComputeProcesses: false })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe('FileGpuLeaseCoordinator', () => {
  it('uses one kernel flock contract for Gemma and Qwen and releases without unlinking', async () => {
    const root = join(tmpdir(), `gpu-flock-${crypto.randomUUID()}`)
    roots.push(root)
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
    const root = join(tmpdir(), `gpu-flock-diagnostic-${crypto.randomUUID()}`)
    roots.push(root)
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
    const root = join(tmpdir(), `gpu-flock-cancel-${crypto.randomUUID()}`)
    roots.push(root)
    const path = join(root, 'exclusive.lock')
    const first = await coordinator(path).acquire('gemma')
    const controller = new AbortController()
    controller.abort()

    await expect(coordinator(path).acquire('qwen3-tts', controller.signal)).rejects.toMatchObject({
      code: 'cancelled',
    })
    await first.release()
  })
})
