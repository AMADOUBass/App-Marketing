import { type DynamicModule, Module } from '@nestjs/common';
import type { FetchLike } from '@app/integrations';
import { GRAPH_FETCH, InstagramConnectionService } from './instagram-connection.service.js';
import { IntegrationsController } from './integrations.controller.js';

@Module({})
export class IntegrationsModule {
  /** `graphFetch` replaces the network in tests (fake Graph API). */
  static register(graphFetch: FetchLike = fetch): DynamicModule {
    return {
      module: IntegrationsModule,
      controllers: [IntegrationsController],
      providers: [{ provide: GRAPH_FETCH, useValue: graphFetch }, InstagramConnectionService],
    };
  }
}
