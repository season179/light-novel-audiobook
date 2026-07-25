import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileGpuGate, SpeechEngineError } from '../src/index.js'

const roots: Array<string> = []

async function expectGpuBusy(promise: Promise<unknown>): Promise<void> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(SpeechEngineError)
    expect((error as SpeechEngineError).code).toBe('gpu-busy')
    return
  }
  throw new Error('Expected GPU lease failure')
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('FileGpuGate', () => {
  it('prevents Gemma and Qwen from holding the shared lease together', async () => {
    const root = join(tmpdir(), `qwen-gpu-gate-${crypto.randomUUID()}`)
    roots.push(root)
    const lockDirectory = join(root, 'exclusive.lock')
    const qwenGate = new FileGpuGate({ lockDirectory, nvidiaSmiExecutable: '/bin/true' })
    const gemmaGate = new FileGpuGate({ lockDirectory, nvidiaSmiExecutable: '/bin/true' })

    const qwenLease = await qwenGate.acquire('qwen3-tts')
    await expectGpuBusy(gemmaGate.acquire('gemma'))
    await qwenLease.release()

    const gemmaLease = await gemmaGate.acquire('gemma')
    await gemmaLease.release()
  })

  it('fails closed when nvidia-smi reports an existing compute process and releases its file lease', async () => {
    const root = join(tmpdir(), `qwen-gpu-active-${crypto.randomUUID()}`)
    roots.push(root)
    const lockDirectory = join(root, 'exclusive.lock')
    const activeGate = new FileGpuGate({ lockDirectory, nvidiaSmiExecutable: '/bin/echo' })
    await expectGpuBusy(activeGate.acquire('qwen3-tts'))

    const availableGate = new FileGpuGate({ lockDirectory, nvidiaSmiExecutable: '/bin/true' })
    const lease = await availableGate.acquire('qwen3-tts')
    await lease.release()
  })

  it('recovers a lease left by a dead owner so restart remains possible', async () => {
    const root = join(tmpdir(), `qwen-gpu-stale-${crypto.randomUUID()}`)
    roots.push(root)
    const lockDirectory = join(root, 'exclusive.lock')
    await mkdir(lockDirectory, { recursive: true })
    await writeFile(
      join(lockDirectory, 'owner.json'),
      `${JSON.stringify({ schemaVersion: 1, owner: 'qwen3-tts', pid: 2_000_000_000 })}\n`,
    )
    const gate = new FileGpuGate({ lockDirectory, nvidiaSmiExecutable: '/bin/true' })

    const lease = await gate.acquire('qwen3-tts')
    await lease.release()
  })
})
