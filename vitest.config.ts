// One run for the whole repository. A package's tests are in its `test` folder, and test what
// it built: `pnpm test` builds first.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
});
