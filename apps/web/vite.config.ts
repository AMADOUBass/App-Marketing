import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Explicit IPv4 loopback: on Windows "localhost" may bind to [::1] only. Browsers still open
    // http://localhost:5173 (they try both addresses).
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Same origin in development: no CORS. The API runs on 127.0.0.1:3000 (pnpm dev).
    proxy: { '/api': 'http://127.0.0.1:3000' },
    // `pnpm tunnel` (Cloudflare quick tunnel) gives a public HTTPS URL for Meta's redirect and for test
    // images. Vite rejects unknown Host headers (DNS rebinding protection): allow only those tunnels.
    allowedHosts: ['.trycloudflare.com'],
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/setup.ts'],
    testTimeout: 15_000,
  },
});
