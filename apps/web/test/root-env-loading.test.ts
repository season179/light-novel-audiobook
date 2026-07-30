import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DIRECTOR_MODE_ENV_VAR,
  loadRepositoryRootEnv,
  OPENAI_API_KEY_ENV_VAR,
  resolveDirectorMode,
  resolveEnvironmentCompositionOptions,
  resolveTransportMode,
  TRANSPORT_MODE_ENV_VAR,
} from '../src/server/environment-composition.js'
import { WebApiError } from '../src/server/errors.js'
import { findRepositoryRoot } from '../src/server/m1-voice-cast.js'

const roots: string[] = []
const original = new Map(
  [TRANSPORT_MODE_ENV_VAR, DIRECTOR_MODE_ENV_VAR, OPENAI_API_KEY_ENV_VAR].map((name) => [
    name,
    process.env[name],
  ]),
)

const restore = (name: string): void => {
  const value = original.get(name)
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

afterEach(async () => {
  for (const name of original.keys()) restore(name)
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'lna-root-env-'))
  roots.push(root)
  return root
}

describe('repository-root .env loading', () => {
  it('loads mode and key before composition selection when using process.env', async () => {
    const root = await temporaryRoot()
    await writeFile(
      path.join(root, '.env'),
      `${TRANSPORT_MODE_ENV_VAR}=fake\n${DIRECTOR_MODE_ENV_VAR}=openai-cloud\n${OPENAI_API_KEY_ENV_VAR}=fake-test-value\n`,
      { mode: 0o600 },
    )
    delete process.env[TRANSPORT_MODE_ENV_VAR]
    delete process.env[DIRECTOR_MODE_ENV_VAR]
    delete process.env[OPENAI_API_KEY_ENV_VAR]

    loadRepositoryRootEnv(process.env, root)

    expect(resolveTransportMode(process.env)).toBe('fake')
    expect(resolveDirectorMode(process.env)).toBe('openai-cloud')
    expect(process.env[OPENAI_API_KEY_ENV_VAR]).toBe('fake-test-value')
  })

  it('loads the root file before the default composition resolves transport mode', async () => {
    delete process.env[TRANSPORT_MODE_ENV_VAR]
    delete process.env[OPENAI_API_KEY_ENV_VAR]
    const repositoryRoot = findRepositoryRoot(process.cwd())
    if (repositoryRoot === undefined) throw new Error('Repository root unavailable in test')
    const load = vi.spyOn(process, 'loadEnvFile').mockImplementation((file) => {
      expect(file).toBe(path.join(repositoryRoot, '.env'))
      process.env[TRANSPORT_MODE_ENV_VAR] = 'fake'
      process.env[OPENAI_API_KEY_ENV_VAR] = 'fake-test-value'
    })

    await expect(resolveEnvironmentCompositionOptions()).resolves.toEqual({})
    expect(load).toHaveBeenCalledOnce()
  })

  it('keeps explicitly exported process variables authoritative', async () => {
    const root = await temporaryRoot()
    await writeFile(
      path.join(root, '.env'),
      `${OPENAI_API_KEY_ENV_VAR}=file-value\n${DIRECTOR_MODE_ENV_VAR}=openai-cloud\n`,
      { mode: 0o600 },
    )
    process.env[OPENAI_API_KEY_ENV_VAR] = 'exported-value'
    process.env[DIRECTOR_MODE_ENV_VAR] = 'local-gemma'

    loadRepositoryRootEnv(process.env, root)

    expect(process.env[OPENAI_API_KEY_ENV_VAR]).toBe('exported-value')
    expect(process.env[DIRECTOR_MODE_ENV_VAR]).toBe('local-gemma')
  })

  it('does not load the host file for injected test environments', async () => {
    const root = await temporaryRoot()
    await writeFile(path.join(root, '.env'), `${OPENAI_API_KEY_ENV_VAR}=file-value\n`, {
      mode: 0o600,
    })
    delete process.env[OPENAI_API_KEY_ENV_VAR]
    const injected: NodeJS.ProcessEnv = { [TRANSPORT_MODE_ENV_VAR]: 'fake' }

    loadRepositoryRootEnv(injected, root)

    expect(injected[OPENAI_API_KEY_ENV_VAR]).toBeUndefined()
    expect(process.env[OPENAI_API_KEY_ENV_VAR]).toBeUndefined()
  })

  it('treats a missing root .env as harmless', async () => {
    const root = await temporaryRoot()
    expect(() => loadRepositoryRootEnv(process.env, root)).not.toThrow()
  })

  it('sanitizes non-missing file failures without logging values or paths', async () => {
    const root = await temporaryRoot()
    await mkdir(path.join(root, '.env'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const error = (() => {
      try {
        loadRepositoryRootEnv(process.env, root)
      } catch (caught: unknown) {
        return caught
      }
      return undefined
    })()

    expect(error).toBeInstanceOf(WebApiError)
    expect((error as WebApiError).message).toBe('Could not load repository-root .env configuration')
    expect((error as Error).message).not.toContain(root)
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('sanitizes parser failures without retaining secret content', async () => {
    const root = await temporaryRoot()
    vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {
      throw new Error('parse failed beside fake-secret-value')
    })

    const error = (() => {
      try {
        loadRepositoryRootEnv(process.env, root)
      } catch (caught: unknown) {
        return caught
      }
      return undefined
    })()

    expect(error).toBeInstanceOf(WebApiError)
    expect((error as Error).message).toBe('Could not load repository-root .env configuration')
    expect(JSON.stringify(error)).not.toContain('fake-secret-value')
    expect((error as Error).cause).toBeUndefined()
  })

  it('finds the repository root from the pnpm app working directory', () => {
    const repositoryRoot = findRepositoryRoot(process.cwd())
    expect(repositoryRoot).toBeDefined()
    expect(findRepositoryRoot(path.join(repositoryRoot as string, 'apps', 'web'))).toBe(
      repositoryRoot,
    )
  })
})
