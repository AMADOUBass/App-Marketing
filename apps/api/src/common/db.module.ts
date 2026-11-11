import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createDb, type Db } from '@app/db';
import { ENV, type Env } from '../config/env.js';

/** Injection token for the tenant-scoped database (see @app/db withTenant). */
export const DB = Symbol('DB');

@Injectable()
class DbLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DB) private readonly db: Db) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.disconnect();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DB,
      inject: [ENV],
      // The pool connects lazily: creating the client does not open a connection.
      useFactory: (env: Env): Db => createDb({ connectionString: env.DATABASE_URL }),
    },
    DbLifecycle,
  ],
  exports: [DB],
})
export class DbModule {}
