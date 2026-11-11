import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { Logger } from 'pino';
import { LOGGER } from './common/tokens.js';
import { InvalidEnvError, parseEnv } from './config/env.js';
import { WorkerModule } from './worker.module.js';

async function bootstrap(): Promise<void> {
  const env = parseEnv(process.env);
  const app = await NestFactory.createApplicationContext(WorkerModule.register(env), {
    logger: ['error', 'warn'],
  });
  app.enableShutdownHooks();
  app.get<Logger>(LOGGER).info({ role: env.PROCESS_ROLE }, 'worker started');
}

try {
  await bootstrap();
} catch (error) {
  // The logger may not exist yet (e.g. invalid env), so write straight to stderr.
  const message = error instanceof InvalidEnvError ? error.message : String(error);
  process.stderr.write(`Failed to start worker: ${message}\n`);
  process.exit(1);
}
