import { type DynamicModule, Module } from '@nestjs/common';
import type { FetchLike } from '@ponctua/integrations';
import { GRAPH_FETCH, InstagramConnectionService } from './instagram-connection.service.js';
import { IntegrationsController } from './integrations.controller.js';
import { SocialAccountsService } from './social-accounts.service.js';

@Module({})
export class IntegrationsModule {
  /** `graphFetch` replaces the network in tests (fake Graph API). */
  static register(graphFetch: FetchLike = fetch): DynamicModule {
    return {
      module: IntegrationsModule,
      // Global: other modules use its public services (registered once, with the test fetch if any).
      global: true,
      controllers: [IntegrationsController],
      providers: [
        { provide: GRAPH_FETCH, useValue: graphFetch },
        InstagramConnectionService,
        SocialAccountsService,
      ],
      exports: [SocialAccountsService],
    };
  }
}
