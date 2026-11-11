import { randomUUIDv7 } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { type Organization, type Prisma, PrismaClient } from './generated/prisma/client.js';

/** Prisma client bound to one organization, valid only inside a `withTenant` callback. */
export type TenantTx = Prisma.TransactionClient;

export class InvalidOrganizationIdError extends Error {
  override readonly name = 'InvalidOrganizationIdError';

  constructor() {
    super('organizationId must be a UUID');
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DbOptions {
  /** Runtime connection string (app_user role: no BYPASSRLS). */
  connectionString: string;
  /** Maximum pool size. */
  maxConnections?: number;
}

export interface Db {
  /**
   * Runs `fn` in a transaction where row-level security only exposes `organizationId`'s rows.
   * This is the only way to query business tables: the raw Prisma client is never exported.
   */
  withTenant<T>(organizationId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T>;
  /** Creates an organization. Its id is generated here so RLS can scope the insert to it. */
  createOrganization(data: { name: string }): Promise<Organization>;
  /** Readiness check: resolves if the database answers within `timeoutMs`. Touches no table. */
  ping(timeoutMs?: number): Promise<void>;
  disconnect(): Promise<void>;
}

export class DatabaseUnavailableError extends Error {
  override readonly name = 'DatabaseUnavailableError';
}

export function createDb(options: DbOptions): Db {
  const adapter = new PrismaPg({
    connectionString: options.connectionString,
    ...(options.maxConnections ? { max: options.maxConnections } : {}),
  });
  const prisma = new PrismaClient({ adapter });

  async function withTenant<T>(organizationId: string, fn: (tx: TenantTx) => Promise<T>) {
    if (!UUID.test(organizationId)) throw new InvalidOrganizationIdError();

    return prisma.$transaction(async (tx) => {
      // `true` = local to this transaction: the setting is gone once the connection returns to the pool.
      await tx.$queryRaw`SELECT set_config('app.org_id', ${organizationId}, true)`;
      return fn(tx);
    });
  }

  return {
    withTenant,
    createOrganization: ({ name }) => {
      const id = randomUUIDv7();
      return withTenant(id, (tx) => tx.organization.create({ data: { id, name } }));
    },
    ping: async (timeoutMs = 2000) => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new DatabaseUnavailableError(`no answer within ${String(timeoutMs)} ms`));
        }, timeoutMs);
      });
      try {
        await Promise.race([prisma.$queryRaw`SELECT 1`, timeout]);
      } catch (error) {
        if (error instanceof DatabaseUnavailableError) throw error;
        throw new DatabaseUnavailableError('database query failed', { cause: error });
      } finally {
        clearTimeout(timer);
      }
    },
    disconnect: () => prisma.$disconnect(),
  };
}
