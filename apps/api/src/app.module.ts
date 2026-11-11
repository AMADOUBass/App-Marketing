import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { ProblemDetailsFilter } from './common/problem-details.filter.js';
import { ENV, type Env } from './config/env.js';
import { createLoggerParams } from './config/logger.js';
import { HealthModule } from './modules/health/health.module.js';

export interface AppModuleOptions {
  /** Overrides the log destination (tests capture logs this way). */
  logStream?: DestinationStream;
}

@Module({})
export class AppModule {
  static register(env: Env, options: AppModuleOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [LoggerModule.forRoot(createLoggerParams(env, options.logStream)), HealthModule],
      providers: [
        { provide: ENV, useValue: env },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
      ],
    };
  }
}
