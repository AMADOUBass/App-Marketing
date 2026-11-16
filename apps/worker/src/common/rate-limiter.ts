import type { PlatformId, RateLimitRule } from '@ponctua/integrations';
import { rateLimitRules } from '@ponctua/integrations';
import type { Redis } from 'ioredis';

/**
 * Token buckets in Valkey (CLAUDE.md section 7, ADR 013), checked and taken atomically in one script:
 * either every bucket of the publication has a token and one is taken from each, or none is taken and
 * the script says how long to wait for the slowest one. Valkey's clock (TIME) is used, so every worker
 * process agrees on time. Each bucket refills continuously: `capacity` tokens per `window`.
 *
 * KEYS: bucket keys. ARGV: capacity, window (ms) for each key, in the same order.
 * Returns { 1, 0 } (taken) or { 0, waitMs }.
 */
const TAKE_SCRIPT = `
local now_parts = redis.call('TIME')
local now = tonumber(now_parts[1]) * 1000 + math.floor(tonumber(now_parts[2]) / 1000)
local wait = 0
local levels = {}
for i, key in ipairs(KEYS) do
  local capacity = tonumber(ARGV[2 * i - 1])
  local window = tonumber(ARGV[2 * i])
  local rate = capacity / window
  local stored = redis.call('HMGET', key, 'tokens', 'ts')
  local tokens = tonumber(stored[1]) or capacity
  local ts = tonumber(stored[2]) or now
  tokens = math.min(capacity, tokens + math.max(0, now - ts) * rate)
  levels[i] = tokens
  if tokens < 1 then
    local need = math.ceil((1 - tokens) / rate)
    if need > wait then wait = need end
  end
end
if wait > 0 then
  return { 0, wait }
end
for i, key in ipairs(KEYS) do
  redis.call('HSET', key, 'tokens', tostring(levels[i] - 1), 'ts', tostring(now))
  redis.call('PEXPIRE', key, tonumber(ARGV[2 * i]))
end
return { 1, 0 }
`;

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

export class RateLimiter {
  constructor(
    private readonly valkey: Redis,
    private readonly prefix: string,
    /** The capability registry by default; tests pass their own rules. */
    private readonly rulesFor: (platform: PlatformId) => readonly RateLimitRule[] = rateLimitRules,
  ) {}

  /** Takes one publication slot for this account on this platform, at every level, or none. */
  async take(platform: PlatformId, socialAccountId: string): Promise<RateLimitDecision> {
    const rules = this.rulesFor(platform);
    if (rules.length === 0) return { allowed: true };

    const keys = rules.map((rule) =>
      rule.scope === 'app'
        ? `${this.prefix}:ratelimit:${platform}:app:${String(rule.windowSeconds)}`
        : `${this.prefix}:ratelimit:${platform}:account:${socialAccountId}:${String(rule.windowSeconds)}`,
    );
    const args = rules.flatMap((rule) => [rule.capacity, rule.windowSeconds * 1000]);
    const [taken, waitMs] = (await this.valkey.eval(
      TAKE_SCRIPT,
      keys.length,
      ...keys,
      ...args,
    )) as [number, number];
    return taken === 1 ? { allowed: true } : { allowed: false, retryAfterMs: waitMs };
  }
}
