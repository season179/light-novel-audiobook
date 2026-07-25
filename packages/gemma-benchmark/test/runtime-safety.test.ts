import { type ChildProcess, execFile as execFileCallback, spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { validateExternalBrainPaths } from '../src/path-safety.js'
import {
  assertSuccessfulRuntimeLifecycle,
  stopOwnedChild,
  waitForPortRelease,
} from '../src/runtime.js'
import { type RuntimeCleanupEvidence, runtimeCleanupEvidenceSchema } from '../src/schemas.js'

const execFile = promisify(execFileCallback)
const roots: string[] = []
const repositoryRoot = resolve(import.meta.dirname, '../../..')
const prepareScript = resolve(import.meta.dirname, '../scripts/prepare-host.sh')

class FakeChild extends EventEmitter {
  pid: number | undefined = 123
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  signals: NodeJS.Signals[] = []

  constructor(private readonly exitOn: NodeJS.Signals | null) {
    super()
  }

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal)
    if (signal === this.exitOn) {
      queueMicrotask(() => {
        this.signalCode = signal
        this.emit('exit', null, signal)
      })
    }
    return true
  }
}

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'gemma-runtime-safety-'))
  roots.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
  )
})

describe('owned runtime cleanup', () => {
  it('accepts only an alive-through-work process and graceful owned shutdown', () => {
    const graceful: RuntimeCleanupEvidence = {
      schema_version: 'runtime-cleanup@1',
      child_exit_observed: true,
      exit_code: 0,
      signal: null,
      termination: 'sigterm',
      sigterm_sent: true,
      sigkill_sent: false,
      exit_awaited: true,
      api_key_file_removed: true,
      port_released: true,
    }
    expect(() =>
      assertSuccessfulRuntimeLifecycle(
        { observed_exited: false, exit_code: null, signal: null },
        graceful,
      ),
    ).not.toThrow()
    expect(() =>
      assertSuccessfulRuntimeLifecycle(
        { observed_exited: true, exit_code: 137, signal: null },
        graceful,
      ),
    ).toThrow('before benchmark work completed')

    const invalidCleanup: RuntimeCleanupEvidence[] = [
      {
        ...graceful,
        termination: 'already_exited',
        sigterm_sent: false,
        exit_code: 137,
      },
      { ...graceful, exit_code: 137 },
      { ...graceful, exit_code: null, signal: 'SIGKILL' },
      {
        ...graceful,
        termination: 'sigkill',
        sigkill_sent: true,
        exit_code: null,
        signal: 'SIGKILL',
      },
    ]
    for (const cleanup of invalidCleanup) {
      expect(() =>
        assertSuccessfulRuntimeLifecycle(
          { observed_exited: false, exit_code: null, signal: null },
          cleanup,
        ),
      ).toThrow('graceful owned shutdown')
    }
    expect(() =>
      runtimeCleanupEvidenceSchema.parse({
        ...graceful,
        termination: 'already_exited',
        sigterm_sent: true,
      }),
    ).toThrow('signals are inconsistent')
    expect(() => runtimeCleanupEvidenceSchema.parse({ ...graceful, signal: 'SIGKILL' })).toThrow(
      'two terminal states',
    )
  })
  it('awaits SIGTERM exit and records the terminal state', async () => {
    const child = new FakeChild('SIGTERM')
    const evidence = await stopOwnedChild(child as unknown as ChildProcess, {
      termTimeoutMs: 20,
      killTimeoutMs: 20,
    })
    expect(evidence).toMatchObject({
      termination: 'sigterm',
      sigterm_sent: true,
      sigkill_sent: false,
      exit_awaited: true,
      signal: 'SIGTERM',
    })
  })

  it('awaits forced SIGKILL exit after the bounded SIGTERM deadline', async () => {
    const child = new FakeChild('SIGKILL')
    const evidence = await stopOwnedChild(child as unknown as ChildProcess, {
      termTimeoutMs: 1,
      killTimeoutMs: 20,
    })
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(evidence).toMatchObject({
      termination: 'sigkill',
      sigterm_sent: true,
      sigkill_sent: true,
      exit_awaited: true,
      signal: 'SIGKILL',
    })
  })

  it('fails when even SIGKILL termination is not observed', async () => {
    const child = new FakeChild(null)
    await expect(
      stopOwnedChild(child as unknown as ChildProcess, {
        termTimeoutMs: 1,
        killTimeoutMs: 1,
      }),
    ).rejects.toThrow('did not exit')
  })

  it('awaits a real child exit and verifies its listener port is released', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        "require('node:net').createServer(()=>{}).listen(0,'127.0.0.1',function(){console.log(this.address().port)})",
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    )
    const chunks: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    await once(child.stdout as NodeJS.EventEmitter, 'data')
    const port = Number(Buffer.concat(chunks).toString('utf8').trim())
    expect(port).toBeGreaterThan(0)
    const evidence = await stopOwnedChild(child)
    await waitForPortRelease(port, 2_000)
    expect(evidence.exit_awaited).toBe(true)
  })
})

describe('external brain path guards', () => {
  it('accepts a distinct ext4 root and rejects Git, TTS, and symlink overlap', async () => {
    const external = await root()
    const { stdout } = await execFile('git', ['rev-parse', '--absolute-git-dir'], {
      cwd: repositoryRoot,
    })
    await expect(
      validateExternalBrainPaths({
        runtimeRoot: external,
        repositoryRoot,
        gitDirectory: stdout.trim(),
        candidates: [{ path: join(external, 'model.gguf'), pathClass: 'model' }],
        ttsRoots: [join(external, '..', 'tts-distinct')],
      }),
    ).resolves.toMatchObject({ proof: { ext4: true, outsideTtsRoots: true } })
    await expect(
      validateExternalBrainPaths({
        runtimeRoot: repositoryRoot,
        repositoryRoot,
        gitDirectory: stdout.trim(),
        candidates: [],
        ttsRoots: [],
      }),
    ).rejects.toThrow('Git')
    await expect(
      validateExternalBrainPaths({
        runtimeRoot: external,
        repositoryRoot,
        gitDirectory: stdout.trim(),
        candidates: [],
        ttsRoots: [external],
      }),
    ).rejects.toThrow('TTS')

    const target = join(external, 'target')
    await mkdir(target)
    const linked = join(external, 'linked')
    await symlink(target, linked)
    await expect(
      validateExternalBrainPaths({
        runtimeRoot: external,
        repositoryRoot,
        gitDirectory: stdout.trim(),
        candidates: [{ path: join(linked, 'model.gguf'), pathClass: 'model' }],
        ttsRoots: [],
      }),
    ).rejects.toThrow('symbolic-link')
  })

  it('runs prepare guards before mutation and covers part/header/license/manifest targets', async () => {
    const clean = join(await root(), 'not-created')
    await execFile('bash', [prepareScript], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        GEMMA_BENCHMARK_ROOT: clean,
        GEMMA_BENCHMARK_GUARD_ONLY: '1',
      },
    })
    await expect(
      import('node:fs/promises').then(async ({ stat }) => await stat(clean)),
    ).rejects.toThrow()

    const guardedTargets = [
      'models/gemma-4-26B_q4_0-it.gguf.part',
      'provenance/hugging-face-revision-api.json.part',
      'provenance/text-model-resolve.headers.part',
      'provenance/Apache-2.0.txt.part',
      'host-build.json.part',
      '.llama.cpp.prepare',
    ]
    for (const target of guardedTargets) {
      const external = await root()
      const targetPath = join(external, target)
      await mkdir(resolve(targetPath, '..'), { recursive: true })
      await symlink('/tmp', targetPath)
      await expect(
        execFile('bash', [prepareScript], {
          cwd: repositoryRoot,
          env: {
            ...process.env,
            GEMMA_BENCHMARK_ROOT: external,
            GEMMA_BENCHMARK_GUARD_ONLY: '1',
          },
        }),
        target,
      ).rejects.toThrow()
    }

    const ttsOverlap = await root()
    await expect(
      execFile('bash', [prepareScript], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          GEMMA_BENCHMARK_ROOT: ttsOverlap,
          GEMMA_BENCHMARK_GUARD_ONLY: '1',
          LIGHT_NOVEL_AUDIOBOOK_TTS_RUNTIME_ROOT: ttsOverlap,
        },
      }),
    ).rejects.toThrow()
  })
})
