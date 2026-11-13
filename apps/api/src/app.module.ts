import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import type { FetchLike } from '@app/integrations';
import type { DestinationStream } from 'pino';
import { DbModule } from './common/db.module.js';
import { ProblemDetailsFilter } from './common/problem-details.filter.js';
import { TenantGuard } from './common/tenant.js';
import { ENV, type Env } from './config/env.js';
import { createLoggerParams } from './config/logger.js';
import { ContentModule } from './modules/content/content.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { IntegrationsModule } from './modules/integrations/integrations.module.js';

export interface AppModuleOptions {
  /** Overrides the log destination (tests capture logs this way). */
  logStream?: DestinationStream;
  /** Replaces the network for Meta Graph API calls (tests use a fake Graph API). */
  graphFetch?: FetchLike;
}

@Module({})
export class AppModule {
  static register(env: Env, options: AppModuleOptions = {}): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [
        LoggerModule.forRoot(createLoggerParams(env, options.logStream)),
        DbModule,
        HealthModule,
        ContentModule,
        IntegrationsModule.register(options.graphFetch),
      ],
      providers: [
        { provide: ENV, useValue: env },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
        // Deny by default: every route needs an organization unless marked @Public().
        { provide: APP_GUARD, useClass: TenantGuard },
      ],
      exports: [ENV],
    };
  }
}
