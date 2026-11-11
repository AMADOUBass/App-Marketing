import { randomUUIDv7 } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDb, type Db, type PublicationState } from '../src/index.js';

let db: Db;

interface Org {
  orgId: string;
  workspaceId: string;
  socialAccountId: string;
}

async function seedOrg(name: string): Promise<Org> {
  const org = await db.createOrganization({ name });
  return db.withTenant(org.id, async (tx) => {
    const workspace = await tx.workspace.create({ data: { organizationId: org.id, name } });
    const account = await tx.socialAccount.create({
      data: {
        organizationId: org.id,
        workspaceId: workspace.id,
        platform: 'instagram',
        externalAccountId: randomUUIDv7(),
        displayName: `${name} IG`,
      },
    });
    return { orgId: org.id, workspaceId: workspace.id, socialAccountId: account.id };
  });
}

/** One post + one target per call (a post targets an account only once). */
async function seedTarget(
  org: Org,
  state: PublicationState,
  scheduledInSeconds: number | null,
): Promise<string> {
  return db.withTenant(org.orgId, async (tx) => {
    const post = await tx.post.create({
      data: { organizationId: org.orgId, workspaceId: org.workspaceId, body: 'secret draft text' },
    });
    const target = await tx.publicationTarget.create({
      data: {
        organizationId: org.orgId,
        postId: post.id,
        socialAccountId: org.socialAccountId,
        state,
        scheduledAt:
          scheduledInSeconds === null ? null : new Date(Date.now() + scheduledInSeconds * 1000),
      },
    });
    return target.id;
  });
}

async function stateOf(org: Org, targetId: string) {
  return db.withTenant(org.orgId, (tx) =>
    tx.publicationTarget.findUniqueOrThrow({ where: { id: targetId } }),
  );
}

let a: Org;
let b: Org;

beforeAll(async () => {
  db = createDb({ connectionString: inject('appUserUrl') });
  a = await seedOrg('Org A');
  b = await seedOrg('Org B');
});

afterAll(async () => {
  await db.disconnect();
});

describe('claimDue (cross-organization hand-off)', () => {
  it('claims due targets of every organization, once, and returns identifiers only', async () => {
    const dueA = await seedTarget(a, 'scheduled', 30);
    const dueB = await seedTarget(b, 'scheduled', -5);
    const later = await seedTarget(a, 'scheduled', 600);
    const draft = await seedTarget(a, 'draft', 10);
    const cancelled = await seedTarget(b, 'cancelled', 10);

    const claimed = await db.scheduler.claimDue({ horizonSeconds: 60, limit: 1000 });

    expect(claimed.map((c) => c.targetId).sort()).toEqual([dueA, dueB].sort());
    for (const item of claimed) {
      // Identifiers and timing only: no post body or account data leaves the function.
      expect(Object.keys(item).sort()).toEqual(
        ['attemptNo', 'organizationId', 'scheduledAt', 'targetId'].sort(),
      );
      expect(item.attemptNo).toBe(1);
    }
    expect(claimed.find((c) => c.targetId === dueB)?.organizationId).toBe(b.orgId);

    expect((await stateOf(a, dueA)).state).toBe('queued');
    expect((await stateOf(a, later)).state).toBe('scheduled');
    expect((await stateOf(a, draft)).state).toBe('draft');
    expect((await stateOf(b, cancelled)).state).toBe('cancelled');

    // Already queued: never claimed twice.
    expect(await db.scheduler.claimDue({ horizonSeconds: 60, limit: 1000 })).toEqual([]);
  });

  it('two concurrent schedulers never claim the same target (FOR UPDATE SKIP LOCKED)', async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 40; i++) ids.add(await seedTarget(i % 2 ? a : b, 'scheduled', 1));

    const second = createDb({ connectionString: inject('appUserUrl') });
    try {
      const [one, two] = await Promise.all([
        db.scheduler.claimDue({ horizonSeconds: 60, limit: 25 }),
        second.scheduler.claimDue({ horizonSeconds: 60, limit: 25 }),
      ]);
      const oneIds = one.map((c) => c.targetId);
      const twoIds = two.map((c) => c.targetId);

      expect(oneIds.filter((id) => twoIds.includes(id))).toEqual([]);
      expect([...oneIds, ...twoIds].sort()).toEqual([...ids].sort());
    } finally {
      await second.disconnect();
    }
  });

  it('rejects out-of-range arguments', async () => {
    await expect(db.scheduler.claimDue({ horizonSeconds: -1, limit: 10 })).rejects.toThrow();
    await expect(db.scheduler.claimDue({ horizonSeconds: 60, limit: 0 })).rejects.toThrow();
    await expect(db.scheduler.claimDue({ horizonSeconds: 60, limit: 5000 })).rejects.toThrow();
  });
});

describe('requeueStale (recovery of lost jobs)', () => {
  it('returns targets stuck in queued with the same attempt number, and only those', async () => {
    const stuck = await seedTarget(a, 'scheduled', -600);
    const fresh = await seedTarget(b, 'scheduled', -1);
    await db.scheduler.claimDue({ horizonSeconds: 60, limit: 1000 });
    // Simulate a crash long ago between the database and the queue.
    await db.withTenant(a.orgId, (tx) =>
      tx.publicationTarget.update({
        where: { id: stuck },
        data: { queuedAt: new Date(Date.now() - 600_000) },
      }),
    );

    const requeued = await db.scheduler.requeueStale({ graceSeconds: 120, limit: 1000 });

    expect(requeued.map((r) => r.targetId)).toEqual([stuck]);
    expect(requeued[0]?.attemptNo).toBe(1);
    expect((await stateOf(b, fresh)).state).toBe('queued');
    // queued_at was refreshed: not returned again right away.
    expect(await db.scheduler.requeueStale({ graceSeconds: 120, limit: 1000 })).toEqual([]);
  });
});

describe('the scheduler path does not weaken tenant isolation', () => {
  it('app_user still cannot read publication_targets without tenant context', async () => {
    const client = new pg.Client({ connectionString: inject('appUserUrl') });
    await client.connect();
    try {
      await expect(client.query('SELECT * FROM publication_targets')).rejects.toThrow(
        /app\.org_id/,
      );
    } finally {
      await client.end();
    }
  });

  it('organization A sees only its own targets', async () => {
    const targets = await db.withTenant(a.orgId, (tx) => tx.publicationTarget.findMany());
    expect(targets.length).toBeGreaterThan(0);
    expect(new Set(targets.map((t) => t.organizationId))).toEqual(new Set([a.orgId]));
  });

  it('app_user cannot become app_scheduler', async () => {
    const client = new pg.Client({ connectionString: inject('appUserUrl') });
    await client.connect();
    try {
      await expect(client.query('SET ROLE app_scheduler')).rejects.toThrow(/permission denied/);
    } finally {
      await client.end();
    }
  });
});
