import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Database tests share one disposable PostgreSQL 18 (Testcontainers).
    globalSetup: ['test/global-setup.ts'],
    hookTimeout: 120_000,
  },
});
