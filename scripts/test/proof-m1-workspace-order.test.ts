import { afterEach, describe, expect, it, vi } from 'vitest'

const mkdir = vi.fn(async () => undefined)

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  mkdir,
}))

const { REPOSITORY_ROOT, USER_DATA_ROOT, resolveSafeWorkspace } = await import(
  '../proof-m1-lib.mjs'
)

afterEach(() => {
  mkdir.mockClear()
})

describe('proof scripts refuse unsafe workspace paths before writing', () => {
  it.each([
    ['repository', `${REPOSITORY_ROOT}/workspace-order-probe`],
    ['user data', `${USER_DATA_ROOT}/workspace-order-probe`],
  ])('rejects a path inside %s without calling mkdir', async (_label, configured) => {
    await expect(
      resolveSafeWorkspace({ configured, prefix: 'unused-workspace-prefix-' }),
    ).rejects.toThrow('workspace resolves inside')
    expect(mkdir).not.toHaveBeenCalled()
  })
})
