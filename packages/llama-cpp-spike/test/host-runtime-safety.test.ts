import { execFile as execFileCallback } from 'node:child_process'
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  spawnPipedChild,
  validateExternalRuntime,
  withOwnedServer,
} from '../scripts/host-runtime-safety'

const execFile = promisify(execFileCallback)
const temporaryRoots: Array<string> = []
const repositoryRoot = resolve(import.meta.dirname, '../../..')
const prepareHost = resolve(import.meta.dirname, '../scripts/prepare-host.sh')

async function temporaryRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `${name}-`))
  temporaryRoots.push(root)
  return root
}

async function gitDirectory(): Promise<string> {
  const { stdout } = await execFile('git', ['rev-parse', '--absolute-git-dir'], {
    cwd: repositoryRoot,
  })
  return await realpath(stdout.trim())
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('real-host external runtime safety', () => {
  it('rejects a runtime root inside the Git worktree before use', async () => {
    await expect(
      validateExternalRuntime({
        runtimeRootInput: resolve(repositoryRoot, 'packages/llama-cpp-spike'),
        worktreeRoot: repositoryRoot,
        repositoryRoot,
        gitDirectory: await gitDirectory(),
        paths: [],
      }),
    ).rejects.toThrow(/overlaps the Git worktree/)
  })

  it('rejects a runtime root that contains the Git worktree', async () => {
    await expect(
      validateExternalRuntime({
        runtimeRootInput: resolve(repositoryRoot, '..'),
        worktreeRoot: repositoryRoot,
        repositoryRoot,
        gitDirectory: await gitDirectory(),
        paths: [],
      }),
    ).rejects.toThrow(/overlaps the Git worktree/)
  })

  it('rejects a model path that escapes through a symlink', async () => {
    const parent = await temporaryRoot('llama-runtime-symlink')
    const runtimeRoot = join(parent, 'runtime')
    const outside = join(parent, 'outside')
    await mkdir(runtimeRoot)
    await mkdir(outside)
    await symlink(outside, join(runtimeRoot, 'models'), 'dir')

    await expect(
      validateExternalRuntime({
        runtimeRootInput: runtimeRoot,
        worktreeRoot: repositoryRoot,
        repositoryRoot,
        gitDirectory: await gitDirectory(),
        paths: [{ path: join(runtimeRoot, 'models', 'model.gguf'), pathClass: 'model' }],
      }),
    ).rejects.toThrow(/symbolic-link component/)
  })

  it('removes the API key when child startup fails', async () => {
    const runtimeRoot = await temporaryRoot('llama-start-failure')
    await expect(
      withOwnedServer({
        runtimeRoot,
        spawnChild: () => spawnPipedChild('/definitely/missing/llama-server', []),
        run: async () => {
          throw new Error('unreachable')
        },
      }),
    ).rejects.toThrow(/failed to start/)
    expect((await readdir(runtimeRoot)).filter((name) => name.startsWith('.run-api-key-'))).toEqual(
      [],
    )
  })

  it('removes the key, terminates the child, and closes streams when the run fails', async () => {
    const runtimeRoot = await temporaryRoot('llama-run-failure')
    let keyFile = ''
    let ownedChild: ReturnType<typeof spawnPipedChild> | undefined
    await expect(
      withOwnedServer({
        runtimeRoot,
        spawnChild: () => {
          ownedChild = spawnPipedChild(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
          return ownedChild
        },
        run: async (context) => {
          keyFile = context.apiKeyFile
          throw new Error('synthetic run failure')
        },
      }),
    ).rejects.toThrow('synthetic run failure')
    await expect(access(keyFile)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(ownedChild?.exitCode !== null || ownedChild?.signalCode !== null).toBe(true)
    expect(ownedChild?.stdout?.destroyed).toBe(true)
    expect(ownedChild?.stderr?.destroyed).toBe(true)
  })

  it('prepare-host rejects a symlinked temporary target before writing it', async () => {
    const parent = await temporaryRoot('llama-prepare-temp-symlink')
    const runtimeRoot = join(parent, 'runtime')
    const outside = join(parent, 'outside-file')
    await mkdir(runtimeRoot)
    await writeFile(outside, 'must remain unchanged')
    await symlink(outside, join(runtimeRoot, 'host-build.json.tmp'), 'file')

    await expect(
      execFile('bash', [prepareHost], {
        cwd: repositoryRoot,
        env: { ...process.env, LLAMA_CPP_SPIKE_ROOT: runtimeRoot },
      }),
    ).rejects.toMatchObject({ code: expect.any(Number) })
    expect(await readFile(outside, 'utf8')).toBe('must remain unchanged')
    expect(await readdir(runtimeRoot)).toEqual(['host-build.json.tmp'])
  })

  it('prepare-host rejects a symlinked license target before creating runtime artifacts', async () => {
    const parent = await temporaryRoot('llama-prepare-symlink')
    const runtimeRoot = join(parent, 'runtime')
    const outside = join(parent, 'outside')
    await mkdir(runtimeRoot)
    await mkdir(outside)
    await symlink(outside, join(runtimeRoot, 'license-evidence'), 'dir')

    await expect(
      execFile('bash', [prepareHost], {
        cwd: repositoryRoot,
        env: { ...process.env, LLAMA_CPP_SPIKE_ROOT: runtimeRoot },
      }),
    ).rejects.toMatchObject({ code: expect.any(Number) })
    expect(await readdir(outside)).toEqual([])
    expect(await readdir(runtimeRoot)).toEqual(['license-evidence'])
  })

  it('prepare-host exit trap removes an existing host-build temporary file on failure', async () => {
    const parent = await temporaryRoot('llama-prepare-trap')
    const runtimeRoot = join(parent, 'runtime')
    const fakeBin = join(parent, 'bin')
    const temporaryManifest = join(runtimeRoot, 'host-build.json.tmp')
    await mkdir(runtimeRoot)
    await mkdir(fakeBin)
    await writeFile(temporaryManifest, 'interrupted write')
    const fakeGit = join(fakeBin, 'git')
    await writeFile(
      fakeGit,
      `#!/usr/bin/env bash\nif [[ "$*" == *"rev-parse --show-toplevel"* ]]; then printf '%s\\n' "${repositoryRoot}"; exit 0; fi\nexit 97\n`,
    )
    await chmod(fakeGit, 0o755)

    await expect(
      execFile('bash', [prepareHost], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          LLAMA_CPP_SPIKE_ROOT: runtimeRoot,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        },
      }),
    ).rejects.toMatchObject({ code: 97 })
    await expect(access(temporaryManifest)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(
      (await readdir(runtimeRoot)).some((name) => name.startsWith('.llama.cpp.prepare.')),
    ).toBe(false)
  })
})
