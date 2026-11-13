import { Secret } from '@ponctua/vault';
import { z } from 'zod';

export const PROCESS_ROLES = ['scheduler', 'publish', 'all'] as const;
export type ProcessRole = (typeof PROCESS_ROLES)[number];

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    LOG_PRETTY: z.stringbool().default(false),
    /** Which loop this process runs. `all` is meant for local development. */
    PROCESS_ROLE: z.enum(PROCESS_ROLES),
    /** Runtime connection (app_user role, subject to row-level security). */
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    VALKEY_URL: z.url({ protocol: /^rediss?$/ }),
    /** Namespace for queues and locks in Valkey (lets tests and environments share an instance). */
    QUEUE_PREFIX: z
      .string()
      .regex(/^[\w-]{1,64}$/)
      .default('app'),
    SCHEDULER_TICK_MS: int(50, 60_000).default(10_000),
    /** Targets due within this window are queued with their exact remaining delay. */
    SCHEDULER_HORIZON_SECONDS: int(0, 3600).default(60),
    SCHEDULER_BATCH_SIZE: int(1, 1000).default(100),
    /** A target still queued this long after its time is considered lost and queued again. */
    SCHEDULER_RECOVERY_GRACE_SECONDS: int(1, 86_400).default(120),
    LEADER_LOCK_TTL_MS: int(100, 300_000).default(30_000),
    /**
     * A target still publishing this long after a worker started it is moved to unknown_outcome
     * (the worker died). Must exceed the slowest legitimate publish (large video uploads).
     */
    PUBLISH_LEASE_SECONDS: int(1, 86_400).default(1800),
    PUBLISH_CONCURRENCY: int(1, 100).default(5),
    /** Feature flag: real Instagram publishing. Off -> targets end in needs_action, nothing is sent. */
    INSTAGRAM_PUBLISHING_ENABLED: z.stringbool().default(false),
    /**
     * Vault master PRIVATE keys, "id:key,id:key" (ADR 006). Worker only: lets it open sealed tokens.
     * Wrapped in a Secret so printing the env never shows them.
     */
    VAULT_MASTER_PRIVATE_KEYS: z
      .string()
      .min(1)
      .transform((value) => new Secret(value))
      .optional(),
  })
  .superRefine((env, ctx) => {
    if (env.INSTAGRAM_PUBLISHING_ENABLED && !env.VAULT_MASTER_PRIVATE_KEYS) {
      ctx.addIssue({
        code: 'custom',
        path: ['VAULT_MASTER_PRIVATE_KEYS'],
        message:
          'required when INSTAGRAM_PUBLISHING_ENABLED=true (tokens must be opened to publish)',
      });
    }
    if (env.LEADER_LOCK_TTL_MS < env.SCHEDULER_TICK_MS * 2) {
      ctx.addIssue({
        code: 'custom',
        path: ['LEADER_LOCK_TTL_MS'],
        message: 'must be at least twice SCHEDULER_TICK_MS (the leader renews it on every tick)',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export const ENV = Symbol('ENV');

export class InvalidEnvError extends Error {
  override readonly name = 'InvalidEnvError';
}

/** Fails fast with variable names and rules only, never the received values (they may be secrets). */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new InvalidEnvError(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
