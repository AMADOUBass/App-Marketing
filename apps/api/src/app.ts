import { StandardSchemaValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { AppModule, type AppModuleOptions } from './app.module.js';
import { API_PREFIX } from './common/paths.js';
import { generateRequestId, registerRequestIdHeader } from './common/request-id.js';
import type { Env } from './config/env.js';

/** Builds the configured application. Shared by main.ts and the tests. */
export async function createApp(
  env: Env,
  options: AppModuleOptions = {},
): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(env, options),
    new FastifyAdapter({ genReqId: generateRequestId }),
    { bufferLogs: true },
  );

  registerRequestIdHeader(app.getHttpAdapter().getInstance());
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix(API_PREFIX);
  app.enableVersioning({ type: VersioningType.URI }); // -> /api/v1/...
  // Validates @Param/@Query/@Body against their Zod schema (`{ schema }` option); 400 on failure.
  app.useGlobalPipes(new StandardSchemaValidationPipe());
  app.enableShutdownHooks();

  return app;
}
