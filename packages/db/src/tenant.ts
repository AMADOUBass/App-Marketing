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
  /**
   * Cross-organization hand-off to the queue (ADR 005). Goes through SECURITY DEFINER functions that
   * only move targets to 'queued' and return identifiers. Process each item inside withTenant().
   */
  scheduler: {
    /** scheduled -> queued for targets due within `horizonSeconds` (each target is claimed once). */
    claimDue(options: { horizonSeconds: number; limit: number }): Promise<DispatchItem[]>;
    /** Targets still queued `graceSeconds` after their time (job probably lost), same attempt number. */
    requeueStale(options: { graceSeconds: number; limit: number }): Promise<DispatchItem[]>;
  };
  disconnect(): Promise<void>;
}

/** What the scheduler may know about a target: identifiers and timing, never content. */
export interface DispatchItem {
  organizationId: string;
  targetId: string;
  scheduledAt: Date;
  attemptNo: number;
}

interface DispatchRow {
  organization_id: string;
  target_id: string;
  scheduled_at: Date;
  attempt_no: number;
}

const toDispatchItem = (row: DispatchRow): DispatchItem => ({
  organizationId: row.organization_id,
  targetId: row.target_id,
  scheduledAt: row.scheduled_at,
  attemptNo: row.attempt_no,
});

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
    scheduler: {
      claimDue: async ({ horizonSeconds, limit }) => {
        const rows = await prisma.$queryRaw<DispatchRow[]>`
          SELECT organization_id, target_id, scheduled_at, attempt_no
          FROM claim_due_publication_targets(${horizonSeconds}::integer, ${limit}::integer)`;
        return rows.map(toDispatchItem);
      },
      requeueStale: async ({ graceSeconds, limit }) => {
        const rows = await prisma.$queryRaw<DispatchRow[]>`
          SELECT organization_id, target_id, scheduled_at, attempt_no
          FROM requeue_stale_publication_targets(${graceSeconds}::integer, ${limit}::integer)`;
        return rows.map(toDispatchItem);
      },
    },
    disconnect: () => prisma.$disconnect(),
  };
}
