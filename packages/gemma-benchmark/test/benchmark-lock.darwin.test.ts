import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireBenchmarkExclusion } from '../src/orchestrator.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const describeDarwin = process.platform === 'darwin' ? describe : describe.skip

describeDarwin('Gemma benchmark Darwin advisory exclusion', () => {
  it('stays nonblocking and leaves the stable lock inode in place', async () => {
    const root = await mkdtemp(join(tmpdir(), 'darwin-benchmark-lock-'))
    roots.push(root)
    const lockPath = join(root, '.experiment.lock')
    const first = await acquireBenchmarkExclusion(lockPath)
    await expect(acquireBenchmarkExclusion(lockPath)).rejects.toThrow(
      'Experiment is already locked by another process',
    )
    await first.release()
    expect((await stat(lockPath)).isFile()).toBe(true)
    const successor = await acquireBenchmarkExclusion(lockPath)
    await successor.release()
    expect((await stat(lockPath)).isFile()).toBe(true)
  })
})
