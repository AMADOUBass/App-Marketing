import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

// Compare-and-renew / compare-and-delete: an instance only touches the lock if it still owns it.
const RENEW = `if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0`;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`;

/**
 * Single active scheduler: the leader holds a Valkey key with a TTL and renews it on every tick.
 * If the leader dies, the key expires and another instance takes over. Correctness never depends on it
 * (claims use FOR UPDATE SKIP LOCKED and job ids are deterministic); it only avoids duplicate work.
 */
export class LeaderLock {
  private readonly token = randomUUID();

  constructor(
    private readonly redis: Redis,
    private readonly key: string,
    private readonly ttlMs: number,
  ) {}

  /** Renews the lock if held, otherwise tries to take it. Returns true if this instance leads. */
  async acquireOrRenew(): Promise<boolean> {
    const renewed = await this.redis.eval(RENEW, 1, this.key, this.token, String(this.ttlMs));
    if (renewed === 1) return true;
    const taken = await this.redis.set(this.key, this.token, 'PX', this.ttlMs, 'NX');
    return taken === 'OK';
  }

  async release(): Promise<void> {
    await this.redis.eval(RELEASE, 1, this.key, this.token);
  }
}
