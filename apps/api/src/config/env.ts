import { Secret } from '@ponctua/vault';
import { z } from 'zod';

/** Secrets are wrapped right at parsing time: printing the env (logs, errors) shows [REDACTED]. */
const secret = (min = 1) =>
  z
    .string()
    .min(min)
    .transform((value) => new Secret(value));

/** Instagram connection (ADR 007). All or nothing: the integration is off until every value is set. */
const INSTAGRAM_KEYS = [
  'META_APP_ID',
  'META_APP_SECRET',
  'INSTAGRAM_CONFIG_ID',
  'INSTAGRAM_REDIRECT_URI',
  'OAUTH_STATE_SECRET',
  'VAULT_MASTER_KEY_ID',
  'VAULT_MASTER_PUBLIC_KEY',
  'WEB_APP_URL',
] as const;

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    LOG_PRETTY: z.stringbool().default(false),
    /** Runtime connection (app_user role, subject to row-level security). */
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    /**
     * Temporary tenant resolution until Better Auth (ADR 003): trusts the x-dev-organization-id header.
     * Refused in production.
     */
    DEV_TENANT_HEADER: z.stringbool().default(false),

    /** Better Auth (ADR 008). Signs session cookies: 32+ random characters, never committed. */
    BETTER_AUTH_SECRET: secret(32),
    /** Public origin the browser uses (the web app, which proxies /api in development). */
    BETTER_AUTH_URL: z.url({ protocol: /^https?$/ }),
    /** Origins allowed to call the auth endpoints (comma-separated). Defaults to BETTER_AUTH_URL. */
    TRUSTED_ORIGINS: z
      .string()
      .optional()
      .transform((value) =>
        (value ?? '')
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),
    /** Per-IP limits on sign-in / sign-up (brute force). Off only in tests that create many users. */
    AUTH_RATE_LIMIT: z.stringbool().default(true),
    /** Identity database role (app_auth): schema "auth" only. */
    AUTH_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),

    /** Meta app id (public). */
    META_APP_ID: z.string().regex(/^\d+$/).optional(),
    /** Meta app secret: server side only, never logged (rule 3). */
    META_APP_SECRET: secret().optional(),
    /** Configuration id from "API setup with Unified login" (public). */
    INSTAGRAM_CONFIG_ID: z.string().regex(/^\d+$/).optional(),
    /** Must be HTTPS and registered in the Meta App Dashboard (documented requirement). */
    INSTAGRAM_REDIRECT_URI: z.url({ protocol: /^https$/ }).optional(),
    /** HMAC key signing the OAuth state (32+ characters). */
    OAUTH_STATE_SECRET: secret(32).optional(),
    /** Vault master PUBLIC key (ADR 006): the API can seal tokens, never read them. */
    VAULT_MASTER_KEY_ID: z
      .string()
      .regex(/^[\w-]{1,64}$/)
      .optional(),
    VAULT_MASTER_PUBLIC_KEY: z.string().optional(),
    /** Where the browser goes back after connecting an account. */
    WEB_APP_URL: z.url({ protocol: /^https?$/ }).optional(),
  })
  .superRefine((env, ctx) => {
    const set = INSTAGRAM_KEYS.filter((key) => env[key] !== undefined);
    if (set.length > 0 && set.length < INSTAGRAM_KEYS.length) {
      for (const key of INSTAGRAM_KEYS.filter((k) => env[k] === undefined)) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'required once any Instagram integration variable is set',
        });
      }
    }
    if (env.NODE_ENV === 'production' && env.DEV_TENANT_HEADER) {
      ctx.addIssue({
        code: 'custom',
        path: ['DEV_TENANT_HEADER'],
        message: 'must not be enabled in production (anyone could pick any organization)',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/** Injection token for the validated environment. */
export const ENV = Symbol('ENV');

export class InvalidEnvError extends Error {
  override readonly name = 'InvalidEnvError';
}

/**
 * Validates environment variables once at startup so the process fails fast with a clear message.
 * The message lists variable names and rules only, never the received values (they may be secrets).
 */
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
