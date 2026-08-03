import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/helpers/env.ts'],
    // All test files share one Postgres database, so they must not run concurrently.
    fileParallelism: false,
    hookTimeout: 20000,
  },
});
