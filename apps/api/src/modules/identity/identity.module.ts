import {
  type DynamicModule,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { createIdentityClient, type IdentityClient } from '@ponctua/db/identity';
import { ENV, type Env } from '../../config/env.js';
import { AUTH, createAuth } from './auth.js';
import { createSmtpMailer, MAILER, type Mailer } from './mailer.js';

const IDENTITY_CLIENT = Symbol('IDENTITY_CLIENT');

@Injectable()
class IdentityLifecycle implements OnApplicationShutdown {
  constructor(@Inject(IDENTITY_CLIENT) private readonly prisma: IdentityClient) {}

  async onApplicationShutdown(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

@Module({})
export class IdentityModule {
  /** `mailer` replaces SMTP (tests). */
  static register(mailer?: Mailer): DynamicModule {
    return {
      module: IdentityModule,
      global: true,
      providers: [
        {
          provide: IDENTITY_CLIENT,
          inject: [ENV],
          // app_auth role: schema "auth" only (ADR 008).
          useFactory: (env: Env) => createIdentityClient(env.AUTH_DATABASE_URL),
        },
        mailer
          ? { provide: MAILER, useValue: mailer }
          : {
              provide: MAILER,
              inject: [ENV],
              useFactory: (env: Env) => createSmtpMailer(env.SMTP_URL, env.MAIL_FROM),
            },
        {
          provide: AUTH,
          inject: [ENV, IDENTITY_CLIENT, MAILER],
          useFactory: createAuth,
        },
        IdentityLifecycle,
      ],
      exports: [AUTH],
    };
  }
}
