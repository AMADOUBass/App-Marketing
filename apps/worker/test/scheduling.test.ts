import type { INestApplicationContext } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createSeeder,
  createTestEnv,
  type Fixture,
  RecordingHandler,
  startWorker,
  waitFor,
} from './helpers.js';

const seed = createSeeder();
const running: INestApplicationContext[] = [];
let a: Fixture;
let b: Fixture;

async function start(...args: Parameters<typeof startWorker>) {
  const app = await startWorker(...args);
  running.push(app);
  return app;
}

beforeAll(async () => {
  a = await seed.org('Org A');
  b = await seed.org('Org B');
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((app) => app.close()));
});

afterAll(async () => {
  await seed.db.disconnect();
});

const inMs = (ms: number) => new Date(Date.now() + ms);

describe('scheduler + publish worker', () => {
  it('publishes a scheduled target on time (not early, under 1 s late)', async () => {
    const handler = new RecordingHandler();
    await start(createTestEnv('all'), handler);
    const scheduledAt = inMs(3000);
    const target = await seed.target(a, 'scheduled', scheduledAt);

    const callFor = () => handler.calls.find((c) => c.target.targetId === target);
    await waitFor(() => callFor() !== undefined);

    const lateness = (callFor()?.at ?? 0) - scheduledAt.getTime();
    expect(lateness).toBeGreaterThanOrEqual(0);
    expect(lateness).toBeLessThan(1000);
    await waitFor(async () => (await seed.state(a, target)) === 'published');
  });

  it('with two scheduler instances, every target of every organization is published exactly once', async () => {
    const handler = new RecordingHandler();
    const env = createTestEnv('scheduler');
    await start(env);
    await start(env);
    await start({ ...env, PROCESS_ROLE: 'publish' }, handler);

    const targets: string[] = [];
    for (let i = 0; i < 10; i++)
      targets.push(await seed.target(i % 2 ? a : b, 'scheduled', inMs(500)));

    await waitFor(() => handler.calls.length >= targets.length);
    await new Promise((resolve) => setTimeout(resolve, 800)); // room for any duplicate to show up

    expect(handler.calls.map((c) => c.target.targetId).sort()).toEqual([...targets].sort());
  });

  it('recovers a target whose job was lost between the database and the queue', async () => {
    const handler = new RecordingHandler();
    const longAgo = new Date(Date.now() - 600_000);
    const target = await seed.target(a, 'queued', longAgo, { queuedAt: longAgo, attemptCount: 1 });

    await start(createTestEnv('all'), handler);

    await waitFor(() => handler.calls.some((c) => c.target.targetId === target));
    expect(handler.calls.filter((c) => c.target.targetId === target)).toEqual([
      expect.objectContaining({ target: expect.objectContaining({ attemptNo: 1 }) as unknown }),
    ]);
  });

  it('without a platform adapter, a due target ends in needs_action, never published', async () => {
    await start(createTestEnv('all'));
    const target = await seed.target(b, 'scheduled', inMs(200));

    await waitFor(async () => (await seed.state(b, target)) === 'needs_action');
  });
});
