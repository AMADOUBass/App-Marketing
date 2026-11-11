import type { INestApplicationContext } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PublishHandler } from '../src/publish/publish-handler.js';
import { PublishProcessor } from '../src/publish/publish.processor.js';
import {
  createSeeder,
  createTestEnv,
  type Fixture,
  RecordingHandler,
  startWorker,
} from './helpers.js';

const seed = createSeeder();
let handler: RecordingHandler;
let app: INestApplicationContext;
let processor: PublishProcessor;
let a: Fixture;
let b: Fixture;

class SwitchableHandler implements PublishHandler {
  current: PublishHandler = new RecordingHandler();
  publish: PublishHandler['publish'] = (target) => this.current.publish(target);
}
const switchable = new SwitchableHandler();

beforeAll(async () => {
  a = await seed.org('Org A');
  b = await seed.org('Org B');
  // Publish role only: the processor is driven directly, no scheduler runs in this file.
  app = await startWorker(createTestEnv('publish'), switchable);
  processor = app.get(PublishProcessor);
});

beforeEach(() => {
  handler = new RecordingHandler();
  switchable.current = handler;
});

afterAll(async () => {
  await app.close();
  await seed.db.disconnect();
});

const queuedTarget = (fixture: Fixture, attemptCount = 1) =>
  // No scheduled_at: these targets are driven by hand and must never be picked up by a scheduler.
  seed.target(fixture, 'queued', null, { queuedAt: new Date(), attemptCount });

describe('a job only ever acts inside its own organization', () => {
  it('skips a job that pairs organization B with a target of A (hidden by RLS)', async () => {
    const targetOfA = await queuedTarget(a);

    const result = await processor.process({
      organizationId: b.orgId,
      targetId: targetOfA,
      attemptNo: 1,
    });

    expect(result).toBe('skipped');
    expect(handler.calls).toEqual([]);
    expect(await seed.state(a, targetOfA)).toBe('queued');
  });
});

describe('publish job idempotence', () => {
  it('publishes a queued target once; the same job again is a no-op', async () => {
    const target = await queuedTarget(a);
    const job = { organizationId: a.orgId, targetId: target, attemptNo: 1 };

    expect(await processor.process(job)).toBe('published');
    expect(await processor.process(job)).toBe('skipped');

    expect(handler.calls.map((c) => c.target.targetId)).toEqual([target]);
    expect(handler.calls[0]?.target).toMatchObject({
      organizationId: a.orgId,
      platform: 'instagram',
    });
    expect(await seed.state(a, target)).toBe('published');
  });

  it('skips a stale attempt', async () => {
    const target = await queuedTarget(a, 2);

    expect(
      await processor.process({ organizationId: a.orgId, targetId: target, attemptNo: 1 }),
    ).toBe('skipped');
    expect(handler.calls).toEqual([]);
  });

  it.each(['scheduled', 'cancelled', 'published', 'publishing'] as const)(
    'skips a target in state %s',
    async (state) => {
      const target = await seed.target(a, state, null, { attemptCount: 1 });

      expect(
        await processor.process({ organizationId: a.orgId, targetId: target, attemptNo: 1 }),
      ).toBe('skipped');
      expect(await seed.state(a, target)).toBe(state);
    },
  );
});

describe('outcomes', () => {
  it('marks unknown_outcome when the adapter throws (never retried blindly)', async () => {
    switchable.current = {
      publish: () => Promise.reject(new Error('socket hang up after upload')),
    };
    const target = await queuedTarget(a);

    expect(
      await processor.process({ organizationId: a.orgId, targetId: target, attemptNo: 1 }),
    ).toBe('unknown_outcome');
    expect(await seed.state(a, target)).toBe('unknown_outcome');
  });

  it('stores what the adapter reports', async () => {
    switchable.current = new RecordingHandler('needs_action');
    const target = await queuedTarget(b);

    expect(
      await processor.process({ organizationId: b.orgId, targetId: target, attemptNo: 1 }),
    ).toBe('needs_action');
    expect(await seed.state(b, target)).toBe('needs_action');
  });
});
