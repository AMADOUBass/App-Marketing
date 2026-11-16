import { randomUUIDv7 } from 'node:crypto';
import type { RateLimitRule } from '@ponctua/integrations';
import type { INestApplicationContext } from '@nestjs/common';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { RateLimiter } from '../src/common/rate-limiter.js';
import { RATE_LIMITER } from '../src/common/tokens.js';
import { PrecheckProcessor } from '../src/publish/precheck.processor.js';
import type {
  PrecheckResult,
  PublishHandler,
  PublishResult,
  ReconcileResult,
} from '../src/publish/publish-handler.js';
import { PublishProcessor } from '../src/publish/publish.processor.js';
import { createSeeder, createTestEnv, type Fixture, startWorker, waitFor } from './helpers.js';

class PrecheckHandler implements PublishHandler {
  result: PrecheckResult = { outcome: 'ok' };
  publishCalls = 0;

  publish(): Promise<PublishResult> {
    this.publishCalls += 1;
    return Promise.resolve({ state: 'published' });
  }

  reconcile(): Promise<ReconcileResult> {
    return Promise.resolve({ outcome: 'unknown' });
  }

  precheck(): Promise<PrecheckResult> {
    return Promise.resolve(this.result);
  }
}

const seed = createSeeder();
let valkey: Redis;
let a: Fixture;
let b: Fixture;

const limiterWith = (rules: RateLimitRule[]) =>
  new RateLimiter(valkey, `t${randomUUIDv7().replaceAll('-', '')}`, () => rules);

const row = (fixture: Fixture, id: string) =>
  seed.db.withTenant(fixture.orgId, (tx) =>
    tx.publicationTarget.findUniqueOrThrow({ where: { id } }),
  );

beforeAll(async () => {
  valkey = new Redis(inject('valkeyUrl'));
  a = await seed.org('Limits A');
  b = await seed.org('Limits B');
});

afterAll(async () => {
  valkey.disconnect();
  await seed.db.disconnect();
});

describe('token buckets in Valkey (ADR 013)', () => {
  it('each account has its own bucket: one account at its limit does not slow another (multi-tenant first)', async () => {
    const limiter = limiterWith([{ scope: 'account', capacity: 2, windowSeconds: 60 }]);

    expect(await limiter.take('instagram', a.socialAccountId)).toEqual({ allowed: true });
    expect(await limiter.take('instagram', a.socialAccountId)).toEqual({ allowed: true });
    const third = await limiter.take('instagram', a.socialAccountId);
    const other = await limiter.take('instagram', b.socialAccountId);

    expect(third.allowed).toBe(false);
    // 2 per 60 s: one token comes back every 30 s.
    expect(third.allowed ? 0 : third.retryAfterMs).toBeGreaterThan(25_000);
    expect(third.allowed ? 0 : third.retryAfterMs).toBeLessThanOrEqual(30_000);
    expect(other).toEqual({ allowed: true });
  });

  it('all levels at once or none: a refusal at one level takes nothing from the others', async () => {
    const limiter = limiterWith([
      { scope: 'app', capacity: 3, windowSeconds: 60 },
      { scope: 'account', capacity: 1, windowSeconds: 60 },
    ]);
    const x = randomUUIDv7();
    const y = randomUUIDv7();

    expect((await limiter.take('instagram', x)).allowed).toBe(true);
    expect((await limiter.take('instagram', x)).allowed).toBe(false); // account empty, app untouched
    expect((await limiter.take('instagram', y)).allowed).toBe(true);
    expect((await limiter.take('instagram', randomUUIDv7())).allowed).toBe(true);
    expect((await limiter.take('instagram', randomUUIDv7())).allowed).toBe(false); // app: 3 used
  });

  it('refills over time', async () => {
    const limiter = limiterWith([{ scope: 'account', capacity: 1, windowSeconds: 1 }]);
    const account = randomUUIDv7();
    expect((await limiter.take('instagram', account)).allowed).toBe(true);
    expect((await limiter.take('instagram', account)).allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect((await limiter.take('instagram', account)).allowed).toBe(true);
  });

  it('Instagram uses the registry: 50 publications per account per 24 h', async () => {
    const limiter = new RateLimiter(valkey, `t${randomUUIDv7().replaceAll('-', '')}`);
    const account = randomUUIDv7();
    for (let i = 0; i < 50; i++) {
      expect((await limiter.take('instagram', account)).allowed).toBe(true);
    }
    const next = await limiter.take('instagram', account);
    expect(next.allowed).toBe(false);
    expect((await limiter.take('linkedin', account)).allowed).toBe(true); // no documented limit
  });
});

describe('a rate-limited publication waits without using an attempt', () => {
  let app: INestApplicationContext;
  const handler = new PrecheckHandler();

  beforeAll(async () => {
    app = await startWorker(createTestEnv('publish'), handler);
  });

  afterAll(async () => {
    await app.close();
  });

  it('over the account budget: the job is told to wait; the target stays queued, attempt unused', async () => {
    const limiter = app.get<RateLimiter>(RATE_LIMITER);
    const fixture = await seed.org('Limited');
    for (let i = 0; i < 50; i++) await limiter.take('instagram', fixture.socialAccountId);
    const id = await seed.target(fixture, 'queued', null, {
      queuedAt: new Date(),
      attemptCount: 1,
    });

    const waitMs = await app
      .get(PublishProcessor)
      .admit({ organizationId: fixture.orgId, targetId: id, attemptNo: 1 });

    expect(waitMs).toBeGreaterThan(0);
    const stored = await row(fixture, id);
    expect(stored.state).toBe('queued');
    expect(stored.attemptCount).toBe(1);
    expect(stored.statusReason).toBe('platform.rate_limited');
    expect(handler.publishCalls).toBe(0);
  });
});

describe('15-minute pre-check (ADR 013)', () => {
  let app: INestApplicationContext;
  let precheck: PrecheckProcessor;
  const handler = new PrecheckHandler();
  const inTenMinutes = () => new Date(Date.now() + 10 * 60 * 1000);

  beforeAll(async () => {
    app = await startWorker(createTestEnv('publish'), handler);
    precheck = app.get(PrecheckProcessor);
  });

  afterAll(async () => {
    await app.close();
  });

  const job = (fixture: Fixture, targetId: string, scheduledAt: Date) => ({
    organizationId: fixture.orgId,
    targetId,
    scheduledAt: scheduledAt.getTime(),
  });

  it('a job pairing organization B with a target of A does nothing (multi-tenant first)', async () => {
    handler.result = { outcome: 'blocked', reason: 'account.not_connected' };
    const at = inTenMinutes();
    const id = await seed.target(a, 'scheduled', at);

    expect(await precheck.process(job(b, id, at))).toBe('skipped');
    expect((await row(a, id)).state).toBe('scheduled');
  });

  it('a blocking problem moves the target to needs_action now, with the reason and an event', async () => {
    handler.result = { outcome: 'blocked', reason: 'account.reconnect' };
    const at = inTenMinutes();
    const id = await seed.target(a, 'scheduled', at);

    expect(await precheck.process(job(a, id, at))).toBe('blocked');

    const stored = await row(a, id);
    expect(stored.state).toBe('needs_action');
    expect(stored.statusReason).toBe('account.reconnect');
    const events = await seed.db.withTenant(a.orgId, (tx) =>
      tx.outboxEvent.findMany({ where: { type: 'publication.needs_action' } }),
    );
    expect(events.some((event) => (event.payload as { targetId?: string }).targetId === id)).toBe(
      true,
    );
  });

  it('a warning keeps it scheduled, with the reason', async () => {
    handler.result = { outcome: 'warning', reason: 'quota.exhausted' };
    const at = inTenMinutes();
    const id = await seed.target(a, 'scheduled', at);

    expect(await precheck.process(job(a, id, at))).toBe('warning');

    const stored = await row(a, id);
    expect(stored.state).toBe('scheduled');
    expect(stored.statusReason).toBe('quota.exhausted');
  });

  it('a check for an older time is ignored (the post was rescheduled)', async () => {
    handler.result = { outcome: 'blocked', reason: 'account.reconnect' };
    const id = await seed.target(a, 'scheduled', inTenMinutes());

    expect(await precheck.process(job(a, id, new Date(Date.now() + 5 * 60 * 1000)))).toBe(
      'skipped',
    );
    expect((await row(a, id)).state).toBe('scheduled');
  });

  it('end to end: the scheduler runs it about 15 minutes ahead, not at the last second', async () => {
    const e2e = new PrecheckHandler();
    e2e.result = { outcome: 'blocked', reason: 'account.not_connected' };
    const worker = await startWorker(createTestEnv('all'), e2e);
    try {
      const id = await seed.target(b, 'scheduled', inTenMinutes());
      const far = await seed.target(b, 'scheduled', new Date(Date.now() + 60 * 60 * 1000));

      await waitFor(async () => (await row(b, id)).state === 'needs_action', 10_000);

      expect((await row(b, far)).state).toBe('scheduled');
      expect((await row(b, far)).precheckedAt).toBeNull();
      expect(e2e.publishCalls).toBe(0);
    } finally {
      await worker.close();
    }
  });
});
