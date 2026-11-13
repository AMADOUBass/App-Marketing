import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@ponctua/contracts';
import type { IdentityClient } from '@ponctua/db/identity';
import { Logger } from '@nestjs/common';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import type { Env } from '../../config/env.js';

/**
 * Better Auth handles identity only: users, sessions (httpOnly cookie), password sign-in.
 * Organizations and memberships stay in our own RLS-protected tables (ADR 008).
 * It runs on its own database role (app_auth), which can only reach the "auth" schema.
 */
/**
 * Client address header set by our Fastify route from the socket (or a trusted proxy, via Fastify's
 * trustProxy), never taken from the client: any incoming value is overwritten. Better Auth keys its
 * rate limits on it.
 */
export const CLIENT_IP_HEADER = 'x-ponctua-client-ip';

/** Attempts per minute and per IP address. */
export const SIGN_IN_LIMIT = 10;
export const SIGN_UP_LIMIT = 5;

export function createAuth(env: Env, prisma: IdentityClient) {
  const logger = new Logger('BetterAuth');
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
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      autoSignIn: true,
    },
    // Memory storage: enough for one api instance. Move to Valkey (secondary storage) before scaling out.
    rateLimit: {
      enabled: env.AUTH_RATE_LIMIT,
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: SIGN_IN_LIMIT },
        '/sign-up/email': { window: 60, max: SIGN_UP_LIMIT },
      },
    },
    advanced: {
      // Ids come from PostgreSQL (uuidv7()), like every other table.
      database: { generateId: false },
      cookiePrefix: 'ponctua',
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      // Better Auth turns the origin (CSRF) check off by itself when it detects a test run. Always on
      // here: tests then cover the real behaviour, and no environment guess can disable it.
      disableOriginCheck: false,
      disableCSRFCheck: false,
    },
    // Into our structured logs (pino). Only the message: extra arguments may carry request data.
    logger: {
      level: 'warn',
      log: (level, message) => {
        if (level === 'error') logger.error(message);
        else if (level === 'warn') logger.warn(message);
        else logger.log(message);
      },
    },
    // No usage data sent to a third party.
    telemetry: { enabled: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;

export const AUTH = Symbol('AUTH');
