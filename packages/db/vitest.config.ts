import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // One disposable PostgreSQL 18 container (Testcontainers) for the whole run.
    globalSetup: ['test/global-setup.ts'],
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
