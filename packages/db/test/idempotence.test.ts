import { randomUUIDv7 } from 'node:crypto';
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
        displayName: name,
      },
    });
    return { orgId: org.id, workspaceId: workspace.id, socialAccountId: account.id };
  });
}

/** A target already handed to a worker (no scheduled_at: the scheduler's claim never sees it). */
async function seedInFlight(
  org: Org,
  state: PublicationState,
  startedSecondsAgo: number | null,
): Promise<string> {
  return db.withTenant(org.orgId, async (tx) => {
    const post = await tx.post.create({
      data: { organizationId: org.orgId, workspaceId: org.workspaceId, body: 'x' },
    });
    const target = await tx.publicationTarget.create({
      data: {
        organizationId: org.orgId,
        postId: post.id,
        socialAccountId: org.socialAccountId,
        state,
        attemptCount: 1,
        publishingStartedAt:
          startedSecondsAgo === null ? null : new Date(Date.now() - startedSecondsAgo * 1000),
      },
    });
    return target.id;
  });
}

const stateOf = (org: Org, id: string) =>
  db
    .withTenant(org.orgId, (tx) => tx.publicationTarget.findUniqueOrThrow({ where: { id } }))
    .then((t) => t.state);

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

describe('publish_attempts', () => {
  it('rejects a second row for the same target attempt (the database-level guard)', async () => {
    const target = await seedInFlight(a, 'publishing', 1);
    const attempt = { organizationId: a.orgId, targetId: target, attemptNo: 1 };

    await db.withTenant(a.orgId, (tx) => tx.publishAttempt.create({ data: attempt }));

    await expect(
      db.withTenant(a.orgId, (tx) => tx.publishAttempt.create({ data: attempt })),
    ).rejects.toThrow(/Unique constraint/i);
  });

  it('is invisible to another organization', async () => {
    const target = await seedInFlight(a, 'publishing', 1);
    await db.withTenant(a.orgId, (tx) =>
      tx.publishAttempt.create({
        data: { organizationId: a.orgId, targetId: target, attemptNo: 1 },
      }),
    );

    const seenByB = await db.withTenant(b.orgId, (tx) =>
      tx.publishAttempt.findMany({ where: { targetId: target } }),
    );
    expect(seenByB).toEqual([]);
  });
});

describe('expireStuck (lease sweep)', () => {
  it('moves targets stuck past the lease to unknown_outcome, in every organization, and nothing else', async () => {
    const stuckA = await seedInFlight(a, 'publishing', 3600);
    const stuckB = await seedInFlight(b, 'uploading', 3600);
    const recent = await seedInFlight(a, 'publishing', 5);
    const done = await seedInFlight(b, 'published', 3600);

    const expired = await db.scheduler.expireStuck({ leaseSeconds: 900, limit: 1000 });

    expect(expired.map((e) => e.targetId).sort()).toEqual([stuckA, stuckB].sort());
    expect(Object.keys(expired[0] ?? {}).sort()).toEqual(
      ['attemptNo', 'organizationId', 'scheduledAt', 'targetId'].sort(),
    );
    expect(await stateOf(a, stuckA)).toBe('unknown_outcome');
    expect(await stateOf(b, stuckB)).toBe('unknown_outcome');
    expect(await stateOf(a, recent)).toBe('publishing');
    expect(await stateOf(b, done)).toBe('published');
  });

  it('an expired target is never claimed again by the scheduler', async () => {
    const stuck = await seedInFlight(a, 'publishing', 3600);
    await db.scheduler.expireStuck({ leaseSeconds: 900, limit: 1000 });

    const claimed = await db.scheduler.claimDue({ horizonSeconds: 3600, limit: 1000 });
    const requeued = await db.scheduler.requeueStale({ graceSeconds: 1, limit: 1000 });

    expect(claimed.map((c) => c.targetId)).not.toContain(stuck);
    expect(requeued.map((c) => c.targetId)).not.toContain(stuck);
    expect(await stateOf(a, stuck)).toBe('unknown_outcome');
  });

  it('rejects out-of-range arguments', async () => {
    await expect(db.scheduler.expireStuck({ leaseSeconds: 0, limit: 10 })).rejects.toThrow();
    await expect(db.scheduler.expireStuck({ leaseSeconds: 900, limit: 0 })).rejects.toThrow();
  });
});
