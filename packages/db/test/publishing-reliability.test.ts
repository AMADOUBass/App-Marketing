import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDb, type Db, type PublicationState } from '../src/index.js';

let db: Db;

interface Org {
  orgId: string;
  workspaceId: string;
  accountId: string;
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
        externalAccountId: randomUUID(),
        displayName: name,
      },
    });
    return { orgId: org.id, workspaceId: workspace.id, accountId: account.id };
  });
}

/** A target in a given state; each needs its own post (unique post x account). */
async function target(
  org: Org,
  state: PublicationState,
  fields: { retryAt?: Date | null; scheduledAt?: Date; attemptCount?: number } = {},
): Promise<string> {
  return db.withTenant(org.orgId, async (tx) => {
    const post = await tx.post.create({
      data: { organizationId: org.orgId, workspaceId: org.workspaceId, body: 'x' },
    });
    const created = await tx.publicationTarget.create({
      data: {
        organizationId: org.orgId,
        postId: post.id,
        socialAccountId: org.accountId,
        state,
        scheduledAt: fields.scheduledAt ?? new Date(),
        retryAt: fields.retryAt ?? null,
        attemptCount: fields.attemptCount ?? 1,
      },
    });
    return created.id;
  });
}

const stateOf = (org: Org, id: string) =>
  db.withTenant(org.orgId, (tx) => tx.publicationTarget.findUniqueOrThrow({ where: { id } }));

const soon = (seconds: number) => new Date(Date.now() + seconds * 1000);

let a: Org;
let b: Org;

beforeAll(async () => {
  db = createDb({ connectionString: inject('appUserUrl') });
  a = await seedOrg('Reliability A');
  b = await seedOrg('Reliability B');
});

afterAll(async () => {
  await db.disconnect();
});

describe('retries (ADR 013)', () => {
  it('hands due retries of every organization to the queue once, with a new attempt number', async () => {
    const dueA = await target(a, 'retrying', { retryAt: soon(-5), attemptCount: 1 });
    const dueB = await target(b, 'retrying', { retryAt: soon(30), attemptCount: 2 });
    const later = await target(a, 'retrying', { retryAt: soon(3600) });

    const claimed = await db.scheduler.claimDueRetries({ horizonSeconds: 60, limit: 100 });
    const again = await db.scheduler.claimDueRetries({ horizonSeconds: 60, limit: 100 });

    const mine = claimed.filter((item) => [dueA, dueB, later].includes(item.targetId));
    expect(mine.map((item) => [item.organizationId, item.targetId, item.attemptNo]).sort()).toEqual(
      [
        [a.orgId, dueA, 2],
        [b.orgId, dueB, 3],
      ].sort(),
    );
    expect(again.filter((item) => [dueA, dueB].includes(item.targetId))).toEqual([]);
    expect((await stateOf(a, dueA)).state).toBe('queued');
    expect((await stateOf(a, later)).state).toBe('retrying');
  });
});

describe('reconciliation claims (ADR 013)', () => {
  it('leases unknown outcomes so a check is not started twice, then hands them back after the lease', async () => {
    const unknown = await target(b, 'unknown_outcome');
    const published = await target(b, 'published');

    const first = await db.scheduler.claimDueReconciliations({ leaseSeconds: 300, limit: 100 });
    const second = await db.scheduler.claimDueReconciliations({ leaseSeconds: 300, limit: 100 });

    expect(first.find((item) => item.targetId === unknown)).toEqual({
      organizationId: b.orgId,
      targetId: unknown,
      checkNo: 0,
    });
    expect(first.find((item) => item.targetId === published)).toBeUndefined();
    expect(second.find((item) => item.targetId === unknown)).toBeUndefined();
    const leased = await stateOf(b, unknown);
    expect(leased.state).toBe('unknown_outcome');
    expect(leased.retryAt?.getTime()).toBeGreaterThan(Date.now() + 250_000);
  });
});

describe('pre-check claims (ADR 013)', () => {
  it('takes each scheduled target due within the lead time once, and nothing else', async () => {
    const dueSoon = await target(a, 'scheduled', { scheduledAt: soon(10 * 60) });
    const farAway = await target(a, 'scheduled', { scheduledAt: soon(2 * 60 * 60) });
    const cancelled = await target(a, 'cancelled', { scheduledAt: soon(60) });

    const first = await db.scheduler.claimDuePrechecks({ leadSeconds: 15 * 60, limit: 100 });
    const second = await db.scheduler.claimDuePrechecks({ leadSeconds: 15 * 60, limit: 100 });

    const ids = first.map((item) => item.targetId);
    expect(ids).toContain(dueSoon);
    expect(ids).not.toContain(farAway);
    expect(ids).not.toContain(cancelled);
    expect(second.map((item) => item.targetId)).not.toContain(dueSoon);
    expect((await stateOf(a, dueSoon)).state).toBe('scheduled');
    expect((await stateOf(a, dueSoon)).precheckedAt).not.toBeNull();
  });
});

describe('transactional outbox (ADR 013)', () => {
  const addEvent = (org: Org, type: string) =>
    db.withTenant(org.orgId, (tx) =>
      tx.outboxEvent.create({
        data: { organizationId: org.orgId, type, payload: { targetId: randomUUID() } },
      }),
    );

  it("an organization only sees its own events; the relay sees everyone's, identifiers only", async () => {
    const eventA = await addEvent(a, 'publication.published');
    const eventB = await addEvent(b, 'publication.failed');

    const seenByA = await db.withTenant(a.orgId, (tx) => tx.outboxEvent.findMany());
    const relayed = await db.outbox.claim({ leaseSeconds: 60, limit: 1000 });

    expect(seenByA.map((event) => event.organizationId)).toEqual(seenByA.map(() => a.orgId));
    const ids = relayed.map((event) => event.eventId);
    expect(ids).toContain(eventA.id);
    expect(ids).toContain(eventB.id);
    expect(relayed.find((event) => event.eventId === eventB.id)).toMatchObject({
      organizationId: b.orgId,
      type: 'publication.failed',
    });
  });

  it("a leased event is not given twice; completed ones never come back; a crashed relay's do", async () => {
    const delivered = await addEvent(a, 'publication.published');
    const crashed = await addEvent(a, 'publication.needs_action');

    const first = await db.outbox.claim({ leaseSeconds: 1, limit: 1000 });
    expect(first.map((event) => event.eventId)).toEqual(
      expect.arrayContaining([delivered.id, crashed.id]),
    );
    expect(await db.outbox.complete([delivered.id])).toBe(1);
    expect(
      (await db.outbox.claim({ leaseSeconds: 1, limit: 1000 })).map((e) => e.eventId),
    ).not.toContain(crashed.id);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    const afterLease = (await db.outbox.claim({ leaseSeconds: 1, limit: 1000 })).map(
      (e) => e.eventId,
    );

    expect(afterLease).toContain(crashed.id);
    expect(afterLease).not.toContain(delivered.id);
    expect(await db.outbox.complete([delivered.id])).toBe(0);
  });
});
