import type { IdentityClient } from '@ponctua/db/identity';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import type { Env } from '../../config/env.js';

/**
 * Better Auth handles identity only: users, sessions (httpOnly cookie), password sign-in.
 * Organizations and memberships stay in our own RLS-protected tables (ADR 008).
 * It runs on its own database role (app_auth), which can only reach the "auth" schema.
 */
export function createAuth(env: Env, prisma: IdentityClient) {
  return betterAuth({
    appName: 'Ponctua',
    baseURL: env.BETTER_AUTH_URL,
    basePath: '/api/auth',
    secret: env.BETTER_AUTH_SECRET.reveal(),
    trustedOrigins:
      env.TRUSTED_ORIGINS.length > 0 ? env.TRUSTED_ORIGINS : [new URL(env.BETTER_AUTH_URL).origin],
    database: prismaAdapter(prisma, { provider: 'postgresql' }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      autoSignIn: true,
    },
    advanced: {
      // Ids come from PostgreSQL (uuidv7()), like every other table.
      database: { generateId: false },
      cookiePrefix: 'ponctua',
    },
    // No usage data sent to a third party.
    telemetry: { enabled: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;

export const AUTH = Symbol('AUTH');
