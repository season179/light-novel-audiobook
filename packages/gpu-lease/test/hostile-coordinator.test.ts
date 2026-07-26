import { readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileGpuLeaseCoordinator, GpuLeaseError } from '../src/index.js'

const TEST_DIR = new URL('.', import.meta.url).pathname

async function* sources(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* sources(path)
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.mjs')) yield path
  }
}

describe('hostile coordinator construction (#67)', () => {
  it('is the only place a wedged-flock coordinator can be built', async () => {
    // Built dynamically so this guard file does not match its own scan. The helper name is the
    // load-bearing detail: it is the one symbol that produces a wedged-flock executable, and the
    // helper always attaches the registration observer, so any outside reference is a site that
    // can construct a hostile holder without durable registration.
    const needle = ['wedged', 'Holder', 'Flock'].join('')
    const offenders: string[] = []
    for await (const path of sources(TEST_DIR)) {
      const name = relative(TEST_DIR, path)
      if (name === 'hostile-coordinator.ts' || name === 'hostile-coordinator.test.ts') continue
      if ((await readFile(path, 'utf8')).includes(needle)) offenders.push(name)
    }
    expect(offenders).toEqual([])
  })

  it('refuses a custom flock executable without a holder observer', () => {
    // The load-bearing constraint: alternate holders exist to be hostile fixtures, and an
    // unobserved hostile holder can never be durably registered. Constructing one is rejected
    // no matter what the fixture or its scripts are named.
    expect(
      () =>
        new FileGpuLeaseCoordinator({
          lockFilePath: join(tmpdir(), `gpu-lease-observerless-${crypto.randomUUID()}.lock`),
          flockExecutable: '/bin/true',
          inspectExistingComputeProcesses: false,
        }),
    ).toThrow(GpuLeaseError)
  })
})
