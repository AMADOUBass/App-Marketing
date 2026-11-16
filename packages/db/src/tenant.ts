import { randomUUIDv7 } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  type Organization,
  type OrganizationRole,
  type Prisma,
  PrismaClient,
} from './generated/prisma/client.js';

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
  /** Onboarding: organization + owner membership + first workspace, in one transaction. */
  createOrganizationWithOwner(data: {
    name: string;
    ownerUserId: string;
    workspaceName: string;
  }): Promise<Organization>;
  /**
   * The only cross-organization read of memberships (ADR 008): organizations `userId` belongs to.
   * Pass the AUTHENTICATED user's id only.
   */
  directory: {
    listOrganizations(userId: string): Promise<UserOrganization[]>;
  };
  /**
   * Runs a create request at most once per Idempotency-Key (CLAUDE.md section 8, ADR 012).
   * The key is inserted first (INSERT ... ON CONFLICT DO NOTHING): a concurrent request with the same
   * key waits for this transaction, then replays its answer. `work` runs in the same transaction as
   * the stored answer: if it throws, nothing is stored and the key can be used again.
   */
  idempotent<T>(
    organizationId: string,
    request: IdempotentRequest,
    work: (tx: TenantTx) => Promise<{ status: number; body: T }>,
  ): Promise<IdempotentResult<T>>;
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
    /** Publishing for longer than `leaseSeconds` (worker died): -> unknown_outcome, reconcile first. */
    expireStuck(options: { leaseSeconds: number; limit: number }): Promise<DispatchItem[]>;
    /** retrying -> queued once retry_at is within `horizonSeconds` (new attempt number; ADR 013). */
    claimDueRetries(options: { horizonSeconds: number; limit: number }): Promise<DispatchItem[]>;
    /** unknown_outcome targets to check with the platform; takes a lease of `leaseSeconds`. */
    claimDueReconciliations(options: {
      leaseSeconds: number;
      limit: number;
    }): Promise<ReconcileItem[]>;
    /** Scheduled targets due within `leadSeconds` whose pre-check has not run (marked taken, once). */
    claimDuePrechecks(options: { leadSeconds: number; limit: number }): Promise<PrecheckItem[]>;
  };
  /** Transactional outbox relay (ADR 013): cross-organization, through SECURITY DEFINER functions. */
  outbox: {
    /** Leases undelivered events (a crashed relay's events come back after `leaseSeconds`). */
    claim(options: { leaseSeconds: number; limit: number }): Promise<OutboxItem[]>;
    /** Marks events handed to the queue. Returns how many were marked. */
    complete(eventIds: readonly string[]): Promise<number>;
  };
  disconnect(): Promise<void>;
}

export interface IdempotentRequest {
  /** Client-generated key (Idempotency-Key header). */
  key: string;
  /** The endpoint, e.g. "POST /posts": a key cannot be reused for another operation. */
  operation: string;
  /** Hash of operation + input: same key, different request -> refused. */
  requestHash: string;
  /** How long the answer is kept for replays. */
  ttlSeconds: number;
}

export type IdempotentResult<T> =
  | { outcome: 'executed'; status: number; body: T }
  | { outcome: 'replayed'; status: number; body: unknown }
  /** The key was already used for another request (different operation or input). */
  | { outcome: 'mismatch' };

export interface UserOrganization {
  organizationId: string;
  name: string;
  role: OrganizationRole;
}

export interface ReconcileItem {
  organizationId: string;
  targetId: string;
  /** How many inconclusive checks came before this one (part of the job id). */
  checkNo: number;
}

export interface PrecheckItem {
  organizationId: string;
  targetId: string;
  scheduledAt: Date;
}

/** An outbox event as the relay sees it: the payload holds identifiers and codes only. */
export interface OutboxItem {
  eventId: string;
  organizationId: string;
  type: string;
  payload: unknown;
  createdAt: Date;
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
    createOrganizationWithOwner: ({ name, ownerUserId, workspaceName }) => {
      if (!UUID.test(ownerUserId)) throw new InvalidOrganizationIdError();
      const id = randomUUIDv7();
      return withTenant(id, async (tx) => {
        const organization = await tx.organization.create({ data: { id, name } });
        await tx.membership.create({
          data: { organizationId: id, userId: ownerUserId, role: 'owner' },
        });
        await tx.workspace.create({ data: { organizationId: id, name: workspaceName } });
        return organization;
      });
    },
    directory: {
      listOrganizations: async (userId) => {
        if (!UUID.test(userId)) return [];
        const rows = await prisma.$queryRaw<
          { organization_id: string; name: string; role: OrganizationRole }[]
        >`SELECT organization_id, name, role FROM list_user_organizations(${userId}::uuid)`;
        return rows.map((row) => ({
          organizationId: row.organization_id,
          name: row.name,
          role: row.role,
        }));
      },
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
      expireStuck: async ({ leaseSeconds, limit }) => {
        const rows = await prisma.$queryRaw<DispatchRow[]>`
          SELECT organization_id, target_id, scheduled_at, attempt_no
          FROM expire_stuck_publications(${leaseSeconds}::integer, ${limit}::integer)`;
        return rows.map(toDispatchItem);
      },
      claimDueRetries: async ({ horizonSeconds, limit }) => {
        const rows = await prisma.$queryRaw<DispatchRow[]>`
          SELECT organization_id, target_id, scheduled_at, attempt_no
          FROM claim_due_retries(${horizonSeconds}::integer, ${limit}::integer)`;
        return rows.map(toDispatchItem);
      },
      claimDueReconciliations: async ({ leaseSeconds, limit }) => {
        const rows = await prisma.$queryRaw<
          { organization_id: string; target_id: string; check_no: number }[]
        >`
          SELECT organization_id, target_id, check_no
          FROM claim_due_reconciliations(${leaseSeconds}::integer, ${limit}::integer)`;
        return rows.map((row) => ({
          organizationId: row.organization_id,
          targetId: row.target_id,
          checkNo: row.check_no,
        }));
      },
      claimDuePrechecks: async ({ leadSeconds, limit }) => {
        const rows = await prisma.$queryRaw<
          { organization_id: string; target_id: string; scheduled_at: Date }[]
        >`
          SELECT organization_id, target_id, scheduled_at
          FROM claim_due_prechecks(${leadSeconds}::integer, ${limit}::integer)`;
        return rows.map((row) => ({
          organizationId: row.organization_id,
          targetId: row.target_id,
          scheduledAt: row.scheduled_at,
        }));
      },
    },
    outbox: {
      claim: async ({ leaseSeconds, limit }) => {
        const rows = await prisma.$queryRaw<
          {
            event_id: string;
            organization_id: string;
            type: string;
            payload: unknown;
            created_at: Date;
          }[]
        >`
          SELECT event_id, organization_id, type, payload, created_at
          FROM claim_outbox_events(${leaseSeconds}::integer, ${limit}::integer)`;
        return rows.map((row) => ({
          eventId: row.event_id,
          organizationId: row.organization_id,
          type: row.type,
          payload: row.payload,
          createdAt: row.created_at,
        }));
      },
      complete: async (eventIds) => {
        if (eventIds.length === 0) return 0;
        const [row] = await prisma.$queryRaw<{ marked: number }[]>`
          SELECT complete_outbox_events(${[...eventIds]}::uuid[]) AS marked`;
        return row?.marked ?? 0;
      },
    },
    idempotent: <T>(
      organizationId: string,
      request: IdempotentRequest,
      work: (tx: TenantTx) => Promise<{ status: number; body: T }>,
    ): Promise<IdempotentResult<T>> =>
      withTenant(organizationId, async (tx) => {
        // An expired key is forgotten, so the client may reuse it.
        await tx.idempotencyKey.deleteMany({
          where: { key: request.key, expiresAt: { lt: new Date() } },
        });
        const expiresAt = new Date(Date.now() + request.ttlSeconds * 1000);
        const inserted = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO idempotency_keys (organization_id, key, operation, request_hash, expires_at)
          VALUES (${organizationId}::uuid, ${request.key}, ${request.operation}, ${request.requestHash}, ${expiresAt})
          ON CONFLICT (organization_id, key) DO NOTHING
          RETURNING id`;
        const [row] = inserted;
        if (!row) {
          const existing = await tx.idempotencyKey.findUniqueOrThrow({
            where: { organizationId_key: { organizationId, key: request.key } },
          });
          if (
            existing.operation !== request.operation ||
            existing.requestHash !== request.requestHash ||
            existing.responseStatus === null
          ) {
            return { outcome: 'mismatch' };
          }
          return {
            outcome: 'replayed',
            status: existing.responseStatus,
            body: existing.responseBody,
          };
        }
        const result = await work(tx);
        await tx.idempotencyKey.update({
          where: { id: row.id },
          data: {
            responseStatus: result.status,
            responseBody: result.body as Prisma.InputJsonValue,
          },
        });
        return { outcome: 'executed', status: result.status, body: result.body };
      }),
    disconnect: () => prisma.$disconnect(),
  };
}
