import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { inject } from 'vitest';
import { createApp } from '../src/app.js';
import { type Env, parseEnv } from '../src/config/env.js';

/** Test environment: real test database, dev tenant header enabled. */
export function createTestEnv(overrides: Record<string, string> = {}): Env {
  return parseEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    DATABASE_URL: inject('databaseUrl'),
    DEV_TENANT_HEADER: 'true',
    BETTER_AUTH_SECRET: 'test-better-auth-secret-0123456789abcdef',
    BETTER_AUTH_URL: 'http://localhost:5173',
    AUTH_DATABASE_URL: inject('authDatabaseUrl'),
    ...overrides,
  });
}

/** In-memory log sink: each entry is one parsed pino JSON line. */
export function createLogCapture() {
  const raw: string[] = [];
  return {
    raw,
    stream: {
      write(chunk: string) {
        raw.push(chunk);
      },
    },
    entries: () => raw.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

export async function createTestApp(
  options: Parameters<typeof createApp>[1] & { env?: Env } = {},
): Promise<NestFastifyApplication> {
  const { env = createTestEnv(), ...appOptions } = options;
  const app = await createApp(env, appOptions);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
