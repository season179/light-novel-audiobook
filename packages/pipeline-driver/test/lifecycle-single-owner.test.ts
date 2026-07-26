/**
 * There must be exactly one `OwnedLlamaLifecycle`, and **the driver's real pipeline must construct
 * that one**.
 *
 * `owned-lifecycle.contract.test.ts` asserts that pipeline-driver's public re-export is
 * gemma-director's class. That is necessary and not sufficient, and the review of
 * issue/lifecycle-dedup proved it by reintroducing the defect in a way the identity check cannot
 * see: restore the deleted local copy, leave `src/index.ts` re-exporting the shared class, and point
 * only `src/transports.ts` at the local one. The advertised symbol still looks consolidated, every
 * contract property still passes, `tsc` still passes — and real runs drive an independently drifting
 * lifecycle. That is the original bug, unobserved.
 *
 * The two guards below close it from opposite directions:
 *
 * 1. **The production binding.** `createRealTransports` is the function that builds a real run. It is
 *    called here for real, with a fabricated runtime layout, and the only construction it is allowed
 *    to make is of the class exported by `@light-novel-audiobook/gemma-director`. Constructing
 *    anything else — a local copy, a subclass, a second import path — records nothing and fails.
 * 2. **The definition count.** Exactly one `OwnedLlamaLifecycle` class body may exist in the
 *    repository's production sources, and it must live in gemma-director. This catches a
 *    reintroduced copy even before anything imports it.
 *
 * Neither can pass vacuously: guard 1 fails on a count of zero as loudly as on a count of two, and
 * guard 2 fails if it finds no definition at all.
 *
 * No GPU, no model, no process: `createRealTransports` only stats its inputs and constructs. The
 * lifecycle it builds is never started, so nothing is spawned and nothing is loaded.
 */
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SELECTED_GEMMA_PROFILE } from '@light-novel-audiobook/gemma-director'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Records every `OwnedLlamaLifecycle` the *package* hands out, so "did production construct this
 * class" is answered by observing a construction rather than by reading an import statement.
 */
const built = vi.hoisted(() => ({
  constructions: [] as unknown[],
  recorder: undefined as unknown,
}))

vi.mock('@light-novel-audiobook/gemma-director', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@light-novel-audiobook/gemma-director')>()
  // A subclass, so behaviour is the real behaviour; only the fact of construction is recorded.
  class RecordingLifecycle extends actual.OwnedLlamaLifecycle {
    constructor(options: ConstructorParameters<typeof actual.OwnedLlamaLifecycle>[0]) {
      super(options)
      built.constructions.push(new.target)
    }
  }
  // Captured so the assertion can name the recording class without reaching into this closure.
  built.recorder = RecordingLifecycle
  return { ...actual, OwnedLlamaLifecycle: RecordingLifecycle }
})

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const roots: string[] = []

afterEach(async () => {
  built.constructions.length = 0
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/**
 * The minimum layout `createRealTransports` insists on before it will construct anything: an
 * executable `llama-server`, the pinned Gemma model file, and a Qwen snapshot directory. All empty —
 * nothing here is ever executed or read as a model.
 */
async function fabricatedRuntimeRoot(): Promise<{
  readonly llamaRuntimeRoot: string
  readonly modelSnapshotPath: string
  readonly gpuLockFilePath: string
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'lna-single-owner-'))
  roots.push(root)
  const binaryPath = path.join(root, 'llama.cpp/build/bin/llama-server')
  await mkdir(path.dirname(binaryPath), { recursive: true })
  await writeFile(binaryPath, '#!/bin/sh\nexit 1\n')
  await chmod(binaryPath, 0o755)
  await mkdir(path.join(root, 'models'), { recursive: true })
  await writeFile(path.join(root, 'models', SELECTED_GEMMA_PROFILE.file), '')
  const modelSnapshotPath = path.join(root, 'qwen-snapshot')
  await mkdir(modelSnapshotPath, { recursive: true })
  return { llamaRuntimeRoot: root, modelSnapshotPath, gpuLockFilePath: path.join(root, 'gpu.lock') }
}

/** Every production source file, i.e. what a real run can reach. Test files are not production. */
async function productionSources(): Promise<readonly string[]> {
  const skip = new Set(['node_modules', '.git', 'dist', '.output', '.vite', '.nitro', 'coverage'])
  const found: string[] = []
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!/\.(?:ts|tsx|mts|js|mjs)$/u.test(entry.name)) continue
      const relative = path.relative(REPO_ROOT, full)
      // `/src/` and `/scripts/` are what ships and what a run executes. Excluding test directories
      // also keeps this file from matching its own recording subclass.
      if (!/(?:^|[\\/])(?:src|scripts)[\\/]/u.test(relative)) continue
      found.push(full)
    }
  }
  await walk(REPO_ROOT)
  return found
}

describe('one OwnedLlamaLifecycle, owned by gemma-director', () => {
  it('is the class createRealTransports actually constructs', async () => {
    // Imported inside the test so the module mock above is in place for transports.ts's own import.
    const { createRealTransports } = await import('../src/transports.js')
    const layout = await fabricatedRuntimeRoot()

    const transports = await createRealTransports({
      directorBaseUrl: 'http://127.0.0.1:8080/v1',
      llamaRuntimeRoot: layout.llamaRuntimeRoot,
      pythonExecutable: process.execPath,
      workerScriptPath: path.join(layout.llamaRuntimeRoot, 'worker.py'),
      runtimeManifestPath: path.join(layout.llamaRuntimeRoot, 'manifest.json'),
      modelSnapshotPath: layout.modelSnapshotPath,
      gpuLockFilePath: layout.gpuLockFilePath,
    })

    // Proves we went through the real function rather than failing early.
    expect(transports.mode).toBe('real')
    expect(transports.director.lifecycle).toBeDefined()
    // THE ASSERTION THIS FILE EXISTS FOR. The class actually constructed must be the one the
    // package exports — the recording class itself — so a subclass that delegates construction but
    // drifts in release() is caught: its new.target is the subclass, not the recording class. A
    // local copy or any second definition never reaches this constructor, so the array is empty.
    expect(
      built.constructions,
      'createRealTransports must construct the class exported by gemma-director through the ' +
        'package export: the recorded new.target must be the recording class itself, so a subclass ' +
        'or wrapper that delegates construction but drifts is caught.',
    ).toEqual([built.recorder])
  })

  it('is the only definition in the repository, and it lives in gemma-director', async () => {
    const definition = /(?:^|\n)\s*(?:export\s+)?(?:abstract\s+)?class\s+OwnedLlamaLifecycle\b/u
    const sources = await productionSources()
    expect(sources.length).toBeGreaterThan(50)

    const definitions: string[] = []
    for (const file of sources) {
      if (definition.test(await readFile(file, 'utf8')))
        definitions.push(path.relative(REPO_ROOT, file))
    }

    expect(definitions).toEqual(['packages/gemma-director/src/owned-llama-lifecycle.ts'])
  })
})
