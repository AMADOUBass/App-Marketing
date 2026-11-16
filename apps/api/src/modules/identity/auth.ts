import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@ponctua/contracts';
import type { IdentityClient } from '@ponctua/db/identity';
import { Logger } from '@nestjs/common';
import { betterAuth } from 'better-auth';
import { passkey } from '@better-auth/passkey';
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from 'better-auth/api';
import { twoFactor } from 'better-auth/plugins';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import type { Env } from '../../config/env.js';
import { type AuthEmailKind, authEmail, languageOf } from './auth-emails.js';
import type { Mailer } from './mailer.js';

/**
 * Client address header set by our Fastify route from the socket (or a trusted proxy, via Fastify's
 * trustProxy), never taken from the client: any incoming value is overwritten. Better Auth keys its
 * rate limits on it.
 */
export const CLIENT_IP_HEADER = 'x-ponctua-client-ip';

/** Attempts per minute and per IP address. */
export const SIGN_IN_LIMIT = 10;
export const SIGN_UP_LIMIT = 5;
export const EMAIL_SEND_LIMIT = 3;

/** Shown in authenticator apps next to the account. */
export const TOTP_ISSUER = 'Ponctua';
/** "Trust this device" skips the code on this browser for 30 days. */
export const TRUST_DEVICE_DAYS = 30;

/**
 * Security changes made from a signed-in session: the owner is told by email, in case the session
 * was not theirs (ADR 010).
 */
/**
 * Adding a passkey gives lasting access to the account: a stolen or forgotten-open session must not be
 * enough. The session has to be recent (signed in within this delay), as for any sensitive change.
 */
export const PASSKEY_FRESH_SESSION_SECONDS = 10 * 60;
const FRESH_SESSION_PATHS = new Set([
  '/passkey/generate-register-options',
  '/passkey/verify-registration',
]);

/**
 * Better Auth's passkey plugin checks WebAuthn signatures but not user verification (PIN, biometrics):
 * a mere tap on a security key would then sign in and skip the second factor. Required here, so a
 * passkey is worth a password + second factor (ADR 011).
 */
function requireUserVerification(userVerified: boolean | undefined): void {
  if (userVerified !== true) {
    throw new APIError('UNAUTHORIZED', {
      code: 'USER_VERIFICATION_REQUIRED',
      message: 'The authenticator did not verify the user (PIN or biometrics)',
    });
  }
}

const NOTIFIED_CHANGES: Record<string, AuthEmailKind> = {
  '/change-password': 'passwordUpdated',
  '/two-factor/disable': 'twoFactorDisabled',
  '/passkey/verify-registration': 'passkeyAdded',
  '/passkey/delete-passkey': 'passkeyRemoved',
};

/** Web pages the email links come back to (relative: same origin as BETTER_AUTH_URL). */
export const EMAIL_VERIFIED_PATH = '/email-verified';
export const RESET_PASSWORD_PATH = '/reset-password';

/**
 * Better Auth handles identity only: users, sessions (httpOnly cookie), password sign-in, email
 * verification and password reset. Organizations and memberships stay in our own RLS-protected
 * tables (ADR 008). It runs on its own database role (app_auth), which reaches the "auth" schema only.
 */
export function createAuth(env: Env, prisma: IdentityClient, mailer: Mailer) {
  const logger = new Logger('BetterAuth');

  /**
   * Starts the send and returns at once (Better Auth runs it in the background): the response time
   * must not tell whether an address has an account. Failures are logged without the link or address.
   */
  const sendAuthEmail = (
    kind: AuthEmailKind,
    to: string,
    request: Request | undefined,
    url?: string,
  ): Promise<void> =>
    mailer.send(authEmail(kind, languageOf(request), to, url)).catch((error: unknown) => {
      logger.error(
        `Could not send the ${kind} email: ${error instanceof Error ? error.name : 'error'}`,
      );
    });

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
      // Verified address before any session (ADR 009). Also makes sign-up answer the same whether or
      // not the address already has an account (checked in Better Auth 1.7.15's sign-up route).
      requireEmailVerification: true,
      resetPasswordTokenExpiresIn: 60 * 60,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: ({ user, url }, request) =>
        sendAuthEmail('resetPassword', user.email, request, url),
      onPasswordReset: ({ user }, request) => sendAuthEmail('passwordChanged', user.email, request),
      // The real owner learns that someone tried; the person signing up sees the usual answer.
      onExistingUserSignUp: ({ user }, request) =>
        sendAuthEmail(
          'existingAccount',
          user.email,
          request,
          new URL('/login', env.BETTER_AUTH_URL).href,
        ),
    },
    emailVerification: {
      sendOnSignUp: true,
      // An unverified user who signs in with the right password gets a fresh link.
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      expiresIn: 24 * 60 * 60,
      sendVerificationEmail: ({ user, url }, request) =>
        sendAuthEmail('verifyEmail', user.email, request, url),
    },
    // Reset tokens and other one-time values are stored hashed: a database leak does not hand them out.
    verification: { storeIdentifier: 'hashed' },
    // Memory storage: enough for one api instance. Move to Valkey (secondary storage) before scaling out.
    rateLimit: {
      enabled: env.AUTH_RATE_LIMIT,
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: SIGN_IN_LIMIT },
        '/sign-up/email': { window: 60, max: SIGN_UP_LIMIT },
        '/send-verification-email': { window: 60, max: EMAIL_SEND_LIMIT },
        '/request-password-reset': { window: 60, max: EMAIL_SEND_LIMIT },
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
      // Emails are sent without making the response wait (see sendAuthEmail).
      backgroundTasks: {
        handler: (task) => {
          void task;
        },
      },
    },
    // Into our structured logs (pino). Only the message: extra arguments may carry request data.
    // Level warn: Better Auth logs some info messages with the email address in them.
    logger: {
      level: 'warn',
      log: (level, message) => {
        if (level === 'error') logger.error(message);
        else logger.warn(message);
      },
    },
    plugins: [
      // WebAuthn passkeys (ADR 011). Relying party = the web app's host; the origin is fixed rather than
      // taken from the request (the plugin's default). Discoverable credentials: sign-in without typing
      // an address. Passkeys do not work from an IP address (127.0.0.1): use localhost in development.
      passkey({
        rpID: new URL(env.BETTER_AUTH_URL).hostname,
        rpName: 'Ponctua',
        origin: new URL(env.BETTER_AUTH_URL).origin,
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        registration: {
          afterVerification: ({ verification }) => {
            requireUserVerification(verification.registrationInfo?.userVerified);
          },
        },
        authentication: {
          afterVerification: ({ verification }) => {
            requireUserVerification(verification.authenticationInfo.userVerified);
          },
        },
      }),
      // TOTP (authenticator app) + 10 one-time backup codes. The secret and the backup codes are
      // stored encrypted with BETTER_AUTH_SECRET; enabling needs the password and a first valid code.
      // Sign-in with a password then holds no session until the code is checked (ADR 010).
      twoFactor({
        issuer: TOTP_ISSUER,
        trustDeviceMaxAge: TRUST_DEVICE_DAYS * 24 * 60 * 60,
        backupCodeOptions: { amount: 10, storeBackupCodes: 'encrypted' },
      }),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (!FRESH_SESSION_PATHS.has(ctx.path)) return;
        const session = await getSessionFromCtx(ctx);
        if (!session) return; // The endpoint itself answers 401.
        const age = Date.now() - new Date(session.session.createdAt).getTime();
        if (age > PASSKEY_FRESH_SESSION_SECONDS * 1000) {
          throw new APIError('FORBIDDEN', {
            code: 'SESSION_NOT_FRESH',
            message: 'Sign in again to make this change',
          });
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        const kind = NOTIFIED_CHANGES[ctx.path];
        const user = ctx.context.session?.user;
        if (!kind || !user || isAPIError(ctx.context.returned)) return;
        void sendAuthEmail(kind, user.email, ctx.request);
        return Promise.resolve();
      }),
    },
    // No usage data sent to a third party.
    telemetry: { enabled: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;

export const AUTH = Symbol('AUTH');
