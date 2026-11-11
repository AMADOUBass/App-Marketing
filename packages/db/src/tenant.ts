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
  disconnect(): Promise<void>;
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
    disconnect: () => prisma.$disconnect(),
  };
}
