import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // One disposable PostgreSQL 18 (Testcontainers) for the whole run.
    globalSetup: ['test/global-setup.ts'],
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
  // SWC is required so decorator metadata is emitted (NestJS dependency injection relies on it).
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
