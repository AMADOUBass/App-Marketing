import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Disposable PostgreSQL 18 and Valkey 8.1 (Testcontainers) for the whole run.
    globalSetup: ['test/global-setup.ts'],
    // The scheduler claims due targets of every organization in the shared test database: one file at a
    // time, so a scheduler never picks up targets seeded by another file.
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
  // SWC is required so decorator metadata is emitted (NestJS dependency injection relies on it).
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
