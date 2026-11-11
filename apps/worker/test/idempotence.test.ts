import type { INestApplicationContext } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { PUBLISH_QUEUE, type PublishJobData } from '../src/common/queues.js';
import type {
  PublishHandler,
  PublishOutcomeState,
  PublishTarget,
} from '../src/publish/publish-handler.js';
import { PublishProcessor } from '../src/publish/publish.processor.js';
import { createSeeder, createTestEnv, type Fixture, startWorker, waitFor } from './helpers.js';

const seed = createSeeder();
const running: INestApplicationContext[] = [];
let a: Fixture;

/** Slow adapter: widens the window in which a duplicate could slip through. */
class SlowHandler implements PublishHandler {
  readonly calls: PublishTarget[] = [];
  constructor(
    private readonly delayMs = 300,
    private readonly outcome: PublishOutcomeState = 'published',
  ) {}
  async publish(target: PublishTarget): Promise<PublishOutcomeState> {
    this.calls.push(target);
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return this.outcome;
  }
}

async function start(...args: Parameters<typeof startWorker>) {
  const app = await startWorker(...args);
  running.push(app);
  return app;
}

/** A target already queued for attempt 1 (no scheduled_at: only these tests drive it). */
const queuedTarget = () =>
  seed.target(a, 'queued', null, { queuedAt: new Date(), attemptCount: 1 });

const attemptsOf = (targetId: string) =>
  seed.db.withTenant(a.orgId, (tx) => tx.publishAttempt.findMany({ where: { targetId } }));

beforeAll(async () => {
  a = await seed.org('Org A');
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((app) => app.close()));
});

afterAll(async () => {
  await seed.db.disconnect();
});

describe('a publication cannot run twice (rule 6)', () => {
  it('two workers receiving 10 duplicate jobs call the adapter exactly once', async () => {
    const handler = new SlowHandler();
    const env = createTestEnv('publish', { PUBLISH_CONCURRENCY: '5' });
    await start(env, handler);
    await start(env, handler);
    const target = await queuedTarget();

    // Duplicates with distinct BullMQ ids, so BullMQ's own job-id dedupe does not hide the race.
    const connection = new Redis(inject('valkeyUrl'), { maxRetriesPerRequest: null });
    const queue = new Queue<PublishJobData>(PUBLISH_QUEUE, {
      connection,
      prefix: env.QUEUE_PREFIX,
    });
    try {
      await queue.addBulk(
        Array.from({ length: 10 }, (_, i) => ({
          name: PUBLISH_QUEUE,
          data: { organizationId: a.orgId, targetId: target, attemptNo: 1 },
          opts: { jobId: `${target}_1-dup${String(i)}` },
        })),
      );
      await waitFor(async () => (await queue.getJobCounts('completed')).completed === 10);
    } finally {
      await queue.close();
      connection.disconnect();
    }

    expect(handler.calls.map((c) => c.targetId)).toEqual([target]);
    expect(await attemptsOf(target)).toHaveLength(1);
    expect(await seed.state(a, target)).toBe('published');
  });

  it('10 simultaneous runs of the same job on two processors publish once', async () => {
    const handler = new SlowHandler();
    const env = createTestEnv('publish');
    const one = (await start(env, handler)).get(PublishProcessor);
    const two = (await start(env, handler)).get(PublishProcessor);
    const target = await queuedTarget();
    const job = { organizationId: a.orgId, targetId: target, attemptNo: 1 };

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => (i % 2 ? one : two).process(job)),
    );

    expect(results.filter((r) => r === 'published')).toHaveLength(1);
    expect(results.filter((r) => r === 'skipped')).toHaveLength(9);
    expect(handler.calls).toHaveLength(1);
    expect(await attemptsOf(target)).toHaveLength(1);
  });
});

describe('a publication never disappears (rule 6)', () => {
  it('worker died mid-publish: a redelivered job does nothing, the lease sweep moves it to unknown_outcome', async () => {
    const handler = new SlowHandler();
    const hourAgo = new Date(Date.now() - 3_600_000);
    const target = await seed.target(a, 'publishing', null, {
      attemptCount: 1,
      publishingStartedAt: hourAgo,
    });
    await seed.db.withTenant(a.orgId, (tx) =>
      tx.publishAttempt.create({
        data: { organizationId: a.orgId, targetId: target, attemptNo: 1, startedAt: hourAgo },
      }),
    );

    // BullMQ redelivers the stalled job to another worker.
    const processor = (await start(createTestEnv('publish'), handler)).get(PublishProcessor);
    expect(
      await processor.process({ organizationId: a.orgId, targetId: target, attemptNo: 1 }),
    ).toBe('skipped');

    // The scheduler's lease sweep closes it; the adapter is never called again.
    await start(createTestEnv('scheduler', { PUBLISH_LEASE_SECONDS: '600' }));
    await waitFor(async () => (await seed.state(a, target)) === 'unknown_outcome');

    expect(handler.calls).toEqual([]);
    expect((await attemptsOf(target))[0]?.finishedAt).toBeNull(); // evidence for reconciliation
  });

  it('lease expired while the adapter was still running: the attempt keeps the reported outcome', async () => {
    let release: (outcome: PublishOutcomeState) => void = () => undefined;
    const blocked: PublishHandler = {
      publish: () =>
        new Promise<PublishOutcomeState>((resolve) => {
          release = resolve;
        }),
    };
    const processor = (await start(createTestEnv('publish'), blocked)).get(PublishProcessor);
    const target = await queuedTarget();

    const run = processor.process({ organizationId: a.orgId, targetId: target, attemptNo: 1 });
    await waitFor(async () => (await seed.state(a, target)) === 'publishing');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await seed.db.scheduler.expireStuck({ leaseSeconds: 1, limit: 1000 });
    release('published');

    expect(await run).toBe('unknown_outcome');
    expect(await seed.state(a, target)).toBe('unknown_outcome');
    expect((await attemptsOf(target))[0]).toMatchObject({ outcome: 'published' });
  });
});
