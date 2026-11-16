import type { Env } from '../config/env.js';
import type { PublishErrorClass } from '../publish/publish-handler.js';

/**
 * Delay before the next attempt (CLAUDE.md section 5: exponential backoff + jitter). Equal jitter: half
 * of the exponential delay is kept, the other half is random, so retries of many targets spread out
 * without ever coming back sooner than half the planned delay. A quota error waits at least
 * QUOTA_RETRY_SECONDS (the platform's window has to move).
 */
export function retryDelaySeconds(
  env: Pick<Env, 'RETRY_BASE_SECONDS' | 'RETRY_MAX_SECONDS' | 'QUOTA_RETRY_SECONDS'>,
  failuresSoFar: number,
  errorClass: PublishErrorClass | null | undefined,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(
    env.RETRY_MAX_SECONDS,
    env.RETRY_BASE_SECONDS * 2 ** Math.max(0, failuresSoFar - 1),
  );
  const jittered = exponential / 2 + random() * (exponential / 2);
  const delay = errorClass === 'quota' ? Math.max(env.QUOTA_RETRY_SECONDS, jittered) : jittered;
  return Math.round(delay);
}

/** Only these classes are retried (CLAUDE.md section 5); auth and content need a human or a fix. */
export const RETRYABLE: readonly PublishErrorClass[] = ['transient', 'quota'];
