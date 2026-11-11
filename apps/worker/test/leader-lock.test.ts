import { randomUUIDv7 } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { LeaderLock } from '../src/scheduler/leader-lock.js';

const connections: Redis[] = [];
function lockPair(ttlMs: number): [LeaderLock, LeaderLock] {
  const key = `test:${randomUUIDv7()}:leader`;
  const make = () => {
    const redis = new Redis(inject('valkeyUrl'));
    connections.push(redis);
    return new LeaderLock(redis, key, ttlMs);
  };
  return [make(), make()];
}

afterAll(() => {
  for (const redis of connections) redis.disconnect();
});

describe('LeaderLock', () => {
  it('has a single leader at a time, which keeps the lock by renewing it', async () => {
    const [one, two] = lockPair(5000);

    expect(await one.acquireOrRenew()).toBe(true);
    expect(await two.acquireOrRenew()).toBe(false);
    expect(await one.acquireOrRenew()).toBe(true);
    expect(await two.acquireOrRenew()).toBe(false);
  });

  it('hands over immediately when the leader releases it', async () => {
    const [one, two] = lockPair(5000);
    await one.acquireOrRenew();

    await one.release();

    expect(await two.acquireOrRenew()).toBe(true);
    expect(await one.acquireOrRenew()).toBe(false);
  });

  it('hands over after the TTL when the leader dies without releasing', async () => {
    const [one, two] = lockPair(300);
    await one.acquireOrRenew();

    await new Promise((resolve) => setTimeout(resolve, 450));

    expect(await two.acquireOrRenew()).toBe(true);
    // The old leader cannot renew a lock it no longer owns.
    expect(await one.acquireOrRenew()).toBe(false);
  });

  it('a non-owner cannot release the lock', async () => {
    const [one, two] = lockPair(5000);
    await one.acquireOrRenew();

    await two.release();

    expect(await two.acquireOrRenew()).toBe(false);
    expect(await one.acquireOrRenew()).toBe(true);
  });
});
