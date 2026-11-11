import { z } from 'zod';

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
  })
  .superRefine((env, ctx) => {
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
