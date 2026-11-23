// One run for the whole repository. A package's tests are in its `test` folder, and test what
// it built: `pnpm test` builds first. The dashboard's run in a browser's document, as its own
// project (apps/dashboard/vite.config.ts).

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: [
            'packages/*/test/**/*.test.ts',
            'apps/*/test/**/*.test.ts',
            'scripts/**/*.test.ts',
          ],
          exclude: ['apps/dashboard/**', '**/node_modules/**'],
        },
      },
      'apps/dashboard',
    ],
  },
});
