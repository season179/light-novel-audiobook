import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts'],
    // Child-process evidence checks can exceed 5s on supported WSL-mounted worktrees.
    testTimeout: 20_000,
  },
})
