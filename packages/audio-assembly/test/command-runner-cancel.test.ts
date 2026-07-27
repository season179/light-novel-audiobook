import { describe, expect, it } from 'vitest'
import { SpawnCommandRunner } from '../src/command-runner.js'

describe('assembly process cancellation', () => {
  it('terminates and reaps the spawned command before resolving', async () => {
    const controller = new AbortController()
    const run = new SpawnCommandRunner().run(
      process.execPath,
      ['-e', 'setInterval(() => undefined, 60_000)'],
      controller.signal,
    )
    setTimeout(() => controller.abort(), 50)

    await expect(run).rejects.toThrow('Audio assembly was stopped')
  })
})
