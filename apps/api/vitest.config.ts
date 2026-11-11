import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
  // SWC is required so decorator metadata is emitted (NestJS dependency injection relies on it).
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
