import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { FileGpuLeaseCoordinator } from '../src/index.js'

const roots: string[] = []
const fixture = fileURLToPath(new URL('./fixtures/darwin-quarantine-worker.mts', import.meta.url))
const tsx = resolve('node_modules/.bin/tsx')
async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'darwin-gpu-lease-'))
  roots.push(value)
  return value
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })))
})
const describeDarwin = process.platform === 'darwin' ? describe : describe.skip

describeDarwin('FileGpuLeaseCoordinator with the Darwin kernel provider', () => {
  it('keeps nonblocking policy and durable fail-closed quarantine outside the lock seam', async () => {
    const directory = await root()
    const lockFilePath = join(directory, 'gpu.lock')
    const first = await new FileGpuLeaseCoordinator({ lockFilePath }).acquire('gemma')
    await expect(
      new FileGpuLeaseCoordinator({ lockFilePath }).acquire('qwen3-tts'),
    ).rejects.toMatchObject({ code: 'busy' })
    await first.release()

    const worker = spawn(tsx, [fixture, lockFilePath], { stdio: ['ignore', 'pipe', 'pipe'] })
    const output = await new Promise<string>((resolveOutput, rejectOutput) => {
      let stdout = ''
      let stderr = ''
      worker.stdout.setEncoding('utf8')
      worker.stderr.setEncoding('utf8')
      worker.stdout.on('data', (chunk: string) => {
        stdout += chunk
      })
      worker.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })
      worker.once('error', rejectOutput)
      worker.once('exit', (code) => {
        if (code === 0) resolveOutput(stdout)
        else rejectOutput(new Error(`quarantine worker failed: ${stderr}`))
      })
    })
    expect(output).toContain('quarantined')
    await expect(
      new FileGpuLeaseCoordinator({ lockFilePath }).acquire('composition'),
    ).rejects.toMatchObject({ code: 'quarantined' })
    const marker = JSON.parse(await readFile(`${lockFilePath}.quarantined`, 'utf8')) as {
      owner: string
      reason: string
    }
    expect(marker).toMatchObject({
      owner: 'gemma',
      reason: 'runtime accelerator residency could not be disproved',
    })
  })

  it('cancels a contended acquisition without disturbing the current owner', async () => {
    const directory = await root()
    const lockFilePath = join(directory, 'gpu.lock')
    const first = await new FileGpuLeaseCoordinator({ lockFilePath }).acquire('gemma')
    const controller = new AbortController()
    controller.abort()
    await expect(
      new FileGpuLeaseCoordinator({ lockFilePath }).acquire('qwen3-tts', controller.signal),
    ).rejects.toMatchObject({ code: 'cancelled' })
    await first.release()
    const successor = await new FileGpuLeaseCoordinator({ lockFilePath }).acquire('qwen3-tts')
    await successor.release()
  })
})
