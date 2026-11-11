import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApp } from '../src/app.js';
import { type Env, parseEnv } from '../src/config/env.js';

export const testEnv: Env = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'info' });

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
  options: Parameters<typeof createApp>[1] = {},
): Promise<NestFastifyApplication> {
  const app = await createApp(testEnv, options);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
