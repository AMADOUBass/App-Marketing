import { randomUUIDv7 } from 'node:crypto';
import type { Db, OrganizationRole } from '@ponctua/db';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { inject } from 'vitest';
import { createApp } from '../src/app.js';
import { ORGANIZATION_HEADER } from '../src/common/tenant.js';
import { type Env, parseEnv } from '../src/config/env.js';

/** Test environment: real test databases (app_user and app_auth roles). */
export function createTestEnv(overrides: Record<string, string> = {}): Env {
  return parseEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    DATABASE_URL: inject('databaseUrl'),
    BETTER_AUTH_SECRET: 'test-better-auth-secret-0123456789abcdef',
    BETTER_AUTH_URL: 'http://localhost:5173',
    AUTH_DATABASE_URL: inject('authDatabaseUrl'),
    // Tests sign up many users from one address; the limit has its own test.
    AUTH_RATE_LIMIT: 'false',
    ...overrides,
  });
}

/** In-memory log sink: each entry is one parsed pino JSON line. */
export function createLogCapture() {
  const raw: string[] = [];
  return {
    raw,
    stream: {
      write(chunk: string) {
        raw.push(chunk);
      },
    },
    entries: () => raw.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

export async function createTestApp(
  options: Parameters<typeof createApp>[1] & { env?: Env } = {},
): Promise<NestFastifyApplication> {
  const { env = createTestEnv(), ...appOptions } = options;
  const app = await createApp(env, appOptions);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

export const TEST_PASSWORD = 'correct-horse-battery-staple';
/** Origin of the web app in tests (BETTER_AUTH_URL): Better Auth checks it on browser requests. */
export const WEB_ORIGIN = 'http://localhost:5173';

export interface TestUser {
  userId: string;
  email: string;
  /** Cookie header value, as a browser would send it back. */
  cookie: string;
}

/** Signs up through Better Auth's real endpoint and keeps the session cookie. */
export async function signUpUser(app: NestFastifyApplication, name: string): Promise<TestUser> {
  const email = `${name.toLowerCase().replace(/\W+/g, '-')}-${randomUUIDv7()}@test.ponctua.local`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { origin: WEB_ORIGIN },
    payload: { name, email, password: TEST_PASSWORD },
  });
  if (res.statusCode !== 200) throw new Error(`sign-up failed: ${String(res.statusCode)}`);
  const raw = res.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return {
    userId: res.json<{ user: { id: string } }>().user.id,
    email,
    cookie: cookies.map((c) => c.split(';')[0]).join('; '),
  };
}

/** Adds the user to an organization (as the app would after an invitation). */
export async function addMember(
  db: Db,
  organizationId: string,
  user: TestUser,
  role: OrganizationRole = 'owner',
): Promise<void> {
  await db.withTenant(organizationId, (tx) =>
    tx.membership.create({ data: { organizationId, userId: user.userId, role } }),
  );
}

/** Headers of a signed-in member acting for an organization. */
export const asMember = (user: TestUser, organizationId: string) => ({
  cookie: user.cookie,
  [ORGANIZATION_HEADER]: organizationId,
});
