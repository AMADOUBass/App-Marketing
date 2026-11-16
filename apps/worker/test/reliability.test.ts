import type { INestApplicationContext } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventsProcessor } from '../src/events/events.processor.js';
import type {
  PublishHandler,
  PublishResult,
  ReconcileResult,
} from '../src/publish/publish-handler.js';
import { PublishProcessor } from '../src/publish/publish.processor.js';
import { ReconcileProcessor } from '../src/publish/reconcile.processor.js';
import { createSeeder, createTestEnv, type Fixture, startWorker, waitFor } from './helpers.js';

/** Answers from a script: one result per call, the last one repeats. */
class ScriptedHandler implements PublishHandler {
  publishes: PublishResult[] = [{ state: 'published' }];
  reconciles: ReconcileResult[] = [{ outcome: 'unknown' }];
  publishCalls = 0;
  reconcileCalls = 0;

  publish(): Promise<PublishResult> {
    const result = this.publishes[Math.min(this.publishCalls, this.publishes.length - 1)];
    this.publishCalls += 1;
    return Promise.resolve(result ?? { state: 'published' });
  }

  reconcile(): Promise<ReconcileResult> {
    const result = this.reconciles[Math.min(this.reconcileCalls, this.reconciles.length - 1)];
    this.reconcileCalls += 1;
    return Promise.resolve(result ?? { outcome: 'unknown' });
  }
}

const seed = createSeeder();
const handler = new ScriptedHandler();
let app: INestApplicationContext;
let publish: PublishProcessor;
let reconcile: ReconcileProcessor;
let a: Fixture;
let b: Fixture;

const TRANSIENT: PublishResult = {
  state: 'failed',
  errorClass: 'transient',
  retryable: true,
  reason: 'platform.transient',
};

const target = (fixture: Fixture, attemptCount = 1) =>
  seed.target(fixture, 'queued', null, { queuedAt: new Date(), attemptCount });

const row = (fixture: Fixture, id: string) =>
  seed.db.withTenant(fixture.orgId, (tx) =>
    tx.publicationTarget.findUniqueOrThrow({ where: { id } }),
  );

const eventsOf = (fixture: Fixture, targetId: string) =>
  seed.db
    .withTenant(fixture.orgId, (tx) => tx.outboxEvent.findMany({ orderBy: { createdAt: 'asc' } }))
    .then((events) =>
      events.filter((event) => (event.payload as { targetId?: string }).targetId === targetId),
    );

/** A target whose last attempt ended without a clear answer (what reconciliation starts from). */
async function unknownTarget(fixture: Fixture, attemptCount = 1): Promise<string> {
  const id = await seed.target(fixture, 'unknown_outcome', null, { attemptCount });
  await seed.db.withTenant(fixture.orgId, (tx) =>
    tx.publishAttempt.create({
      data: {
        organizationId: fixture.orgId,
        targetId: id,
        attemptNo: attemptCount,
        response: { containerId: 'c-1' },
      },
    }),
  );
  return id;
}

const runPublish = (fixture: Fixture, targetId: string, attemptNo = 1) =>
  publish.process({ organizationId: fixture.orgId, targetId, attemptNo });

beforeAll(async () => {
  a = await seed.org('Reliability A');
  b = await seed.org('Reliability B');
  // Publish role only: processors are driven by hand, no scheduler runs here.
  app = await startWorker(
    createTestEnv('publish', {
      PUBLISH_MAX_ATTEMPTS: '3',
      RETRY_BASE_SECONDS: '60',
      QUOTA_RETRY_SECONDS: '900',
      RECONCILE_MAX_CHECKS: '3',
    }),
    handler,
  );
  publish = app.get(PublishProcessor);
  reconcile = app.get(ReconcileProcessor);
});

afterAll(async () => {
  await app.close();
  await seed.db.disconnect();
});

describe('a reconciliation job only acts inside its own organization (multi-tenant first)', () => {
  it('pairing organization B with a target of A does nothing', async () => {
    const targetOfA = await unknownTarget(a);
    const calls = handler.reconcileCalls;

    const result = await reconcile.process({
      organizationId: b.orgId,
      targetId: targetOfA,
      checkNo: 0,
    });

    expect(result).toBe('skipped');
    expect(handler.reconcileCalls).toBe(calls);
    expect((await row(a, targetOfA)).state).toBe('unknown_outcome');
  });
});

describe('retries (transient and quota only, exponential backoff with jitter)', () => {
  it('a retryable transient failure becomes retrying, 30 to 60 s later (base 60 s, half jitter)', async () => {
    handler.publishes = [TRANSIENT];
    handler.publishCalls = 0;
    const id = await target(a);
    const before = Date.now();

    expect(await runPublish(a, id)).toBe('retrying');

    const stored = await row(a, id);
    expect(stored.statusReason).toBe('platform.transient');
    const delay = (stored.retryAt?.getTime() ?? 0) - before;
    expect(delay).toBeGreaterThanOrEqual(29_000);
    expect(delay).toBeLessThanOrEqual(61_000);
    expect(await eventsOf(a, id)).toEqual([]); // not final: nobody is notified yet
  });

  it('a quota error waits at least QUOTA_RETRY_SECONDS', async () => {
    handler.publishes = [{ ...TRANSIENT, errorClass: 'quota', reason: 'platform.quota' }];
    handler.publishCalls = 0;
    const id = await target(a);

    await runPublish(a, id);

    const stored = await row(a, id);
    expect(stored.state).toBe('retrying');
    expect((stored.retryAt?.getTime() ?? 0) - Date.now()).toBeGreaterThan(890_000);
  });

  it('content and auth errors are never retried', async () => {
    handler.publishes = [
      { state: 'failed', errorClass: 'content', retryable: false, reason: 'platform.content' },
    ];
    handler.publishCalls = 0;
    const id = await target(a);

    expect(await runPublish(a, id)).toBe('failed');
    expect((await row(a, id)).retryAt).toBeNull();
  });

  it('after the last attempt, a transient failure is final (retries.exhausted)', async () => {
    handler.publishes = [TRANSIENT];
    handler.publishCalls = 0;
    const id = await target(a, 3);

    expect(await runPublish(a, id, 3)).toBe('failed');
    expect((await row(a, id)).statusReason).toBe('retries.exhausted');
  });
});

describe('transactional outbox', () => {
  it('a final state writes its event in the same organization, identifiers and codes only', async () => {
    handler.publishes = [{ state: 'published' }];
    handler.publishCalls = 0;
    const id = await target(a);

    await runPublish(a, id);

    const events = await eventsOf(a, id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      organizationId: a.orgId,
      type: 'publication.published',
      payload: {
        targetId: id,
        socialAccountId: a.socialAccountId,
        state: 'published',
        reason: null,
      },
      deliveredAt: null,
    });
    expect(
      await seed.db.withTenant(b.orgId, (tx) =>
        tx.outboxEvent.count({ where: { id: events[0]?.id ?? '' } }),
      ),
    ).toBe(0);
  });
});

describe('reconciliation of unknown outcomes', () => {
  it('confirmed by the platform -> published, with the check recorded on the attempt', async () => {
    handler.reconciles = [{ outcome: 'published', response: { remoteMediaId: 'm-1' } }];
    handler.reconcileCalls = 0;
    const id = await unknownTarget(a);

    expect(await reconcile.process({ organizationId: a.orgId, targetId: id, checkNo: 0 })).toBe(
      'published',
    );

    expect((await row(a, id)).statusReason).toBe('outcome.confirmed');
    const attempt = await seed.db.withTenant(a.orgId, (tx) =>
      tx.publishAttempt.findFirstOrThrow({ where: { targetId: id } }),
    );
    expect(attempt.response).toMatchObject({
      containerId: 'c-1',
      remoteMediaId: 'm-1',
      reconciliation: 'published',
    });
    expect((await eventsOf(a, id)).map((event) => event.type)).toEqual(['publication.published']);
  });

  it('certainly not published and retryable -> retrying (a new attempt may go)', async () => {
    handler.reconciles = [
      {
        outcome: 'not_published',
        errorClass: 'transient',
        retryable: true,
        reason: 'outcome.not_sent',
      },
    ];
    handler.reconcileCalls = 0;
    const id = await unknownTarget(a);

    expect(await reconcile.process({ organizationId: a.orgId, targetId: id, checkNo: 0 })).toBe(
      'retrying',
    );
    expect((await row(a, id)).statusReason).toBe('outcome.not_sent');
  });

  it('still unclear -> asked again later; after RECONCILE_MAX_CHECKS a human decides', async () => {
    handler.reconciles = [{ outcome: 'unknown' }];
    handler.reconcileCalls = 0;
    const id = await unknownTarget(a);

    expect(await reconcile.process({ organizationId: a.orgId, targetId: id, checkNo: 0 })).toBe(
      'unknown_outcome',
    );
    const once = await row(a, id);
    expect(once.reconcileCount).toBe(1);
    expect(once.retryAt?.getTime()).toBeGreaterThan(Date.now());

    // A job for an older check is stale.
    expect(await reconcile.process({ organizationId: a.orgId, targetId: id, checkNo: 0 })).toBe(
      'skipped',
    );
    await reconcile.process({ organizationId: a.orgId, targetId: id, checkNo: 1 });
    expect(await reconcile.process({ organizationId: a.orgId, targetId: id, checkNo: 2 })).toBe(
      'needs_action',
    );
    expect((await row(a, id)).statusReason).toBe('outcome.unconfirmed');
    expect((await eventsOf(a, id)).map((event) => event.type)).toEqual([
      'publication.needs_action',
    ]);
  });
});

describe('end to end, with the scheduler and the outbox relay', () => {
  it('a transient failure is retried by the scheduler, then published; the event reaches the queue', async () => {
    const e2eHandler = new ScriptedHandler();
    e2eHandler.publishes = [TRANSIENT, { state: 'published' }];
    const worker = await startWorker(
      createTestEnv('all', { RETRY_BASE_SECONDS: '1', RETRY_MAX_SECONDS: '1' }),
      e2eHandler,
    );
    try {
      const id = await seed.target(a, 'scheduled', new Date());

      await waitFor(async () => (await row(a, id)).state === 'published', 15_000);

      const stored = await row(a, id);
      expect(stored.attemptCount).toBe(2);
      expect(e2eHandler.publishCalls).toBe(2);
      const events = worker.get(EventsProcessor);
      await waitFor(
        () =>
          events.handled.some(
            (event) =>
              event.type === 'publication.published' &&
              (event.payload as { targetId?: string }).targetId === id,
          ),
        10_000,
      );
      expect((await eventsOf(a, id))[0]?.deliveredAt).not.toBeNull();
    } finally {
      await worker.close();
    }
  });

  it('an unknown outcome (worker died mid-publish) is reconciled, never published again', async () => {
    const e2eHandler = new ScriptedHandler();
    e2eHandler.reconciles = [{ outcome: 'published' }];
    const worker = await startWorker(createTestEnv('all'), e2eHandler);
    try {
      const id = await unknownTarget(b);

      await waitFor(async () => (await row(b, id)).state === 'published', 15_000);

      expect(e2eHandler.publishCalls).toBe(0);
      expect(e2eHandler.reconcileCalls).toBe(1);
    } finally {
      await worker.close();
    }
  });
});
