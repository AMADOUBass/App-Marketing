import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createIdentityClient, type IdentityClient } from '@ponctua/db/identity';
import { ENV, type Env } from '../../config/env.js';
import { AUTH, createAuth } from './auth.js';

const IDENTITY_CLIENT = Symbol('IDENTITY_CLIENT');

@Injectable()
class IdentityLifecycle implements OnApplicationShutdown {
  constructor(@Inject(IDENTITY_CLIENT) private readonly prisma: IdentityClient) {}

  async onApplicationShutdown(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: IDENTITY_CLIENT,
      inject: [ENV],
      // app_auth role: schema "auth" only (ADR 008).
      useFactory: (env: Env) => createIdentityClient(env.AUTH_DATABASE_URL),
    },
    {
      provide: AUTH,
      inject: [ENV, IDENTITY_CLIENT],
      useFactory: createAuth,
    },
    IdentityLifecycle,
  ],
  exports: [AUTH],
})
export class IdentityModule {}
