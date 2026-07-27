import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/**/test/**/*.test.ts',
      'apps/**/test/**/*.test.ts',
      // Component tests written in JSX (the apps' tsconfig already typechecks them).
      'apps/**/test/**/*.test.tsx',
      // The proof/listening scripts are not part of any package, and nothing else executes them.
      'scripts/test/**/*.test.ts',
    ],
    // Child-process evidence checks can exceed 5s on supported WSL-mounted worktrees.
    testTimeout: 20_000,
  },
})
