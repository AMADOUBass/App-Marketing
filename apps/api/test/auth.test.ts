import { randomUUIDv7 } from 'node:crypto';
import { createDb, type Db } from '@ponctua/db';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { ORGANIZATION_HEADER } from '../src/common/tenant.js';
import { CLIENT_IP_HEADER, SIGN_IN_LIMIT } from '../src/modules/identity/auth.js';
import { createLogCapture, createTestApp, createTestEnv } from './helpers.js';

const PASSWORD = 'correct-horse-battery-staple';

interface SignedIn {
  userId: string;
  cookie: string;
}

let app: NestFastifyApplication;
let db: Db;
const logs = createLogCapture();

/** Signs up through Better Auth's real endpoint and keeps the session cookie, like a browser would. */
async function signUp(name: string): Promise<SignedIn & { setCookie: string[]; body: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { origin: 'http://localhost:5173' },
    payload: {
      name,
      email: `${name.toLowerCase()}-${randomUUIDv7()}@test.ponctua.local`,
      password: PASSWORD,
    },
  });
  expect(res.statusCode).toBe(200);
  const raw = res.headers['set-cookie'];
  const setCookie = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  return {
    userId: res.json<{ user: { id: string } }>().user.id,
    cookie,
    setCookie,
    body: res.body,
  };
}

const asMember = (user: SignedIn, organizationId: string) => ({
  cookie: user.cookie,
  [ORGANIZATION_HEADER]: organizationId,
});

async function createOrganization(user: SignedIn, name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/organizations',
    headers: { cookie: user.cookie },
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ organizationId: string }>().organizationId;
}

async function addPost(organizationId: string, body: string): Promise<string> {
  return db.withTenant(organizationId, async (tx) => {
    const workspace = await tx.workspace.findFirstOrThrow();
    const post = await tx.post.create({
      data: { organizationId, workspaceId: workspace.id, body },
    });
    return post.id;
  });
}

beforeAll(async () => {
  db = createDb({ connectionString: inject('databaseUrl') });
  app = await createTestApp({
    env: createTestEnv(),
    logStream: logs.stream,
  });
});

afterAll(async () => {
  await app.close();
  await db.disconnect();
});

describe('organizations are isolated between signed-in users (multi-tenant first)', () => {
  it('a member of A gets 403 on B, even with a valid session; data of A stays readable for A only', async () => {
    const alice = await signUp('Alice');
    const bob = await signUp('Bob');
    const orgA = await createOrganization(alice, 'Agence Alice');
    const orgB = await createOrganization(bob, 'Agence Bob');
    const postA = await addPost(orgA, 'Post de A');
    const postB = await addPost(orgB, 'Post de B');

    const own = await app.inject({ url: '/api/v1/posts', headers: asMember(alice, orgA) });
    expect(own.statusCode).toBe(200);
    expect(own.json<{ items: { id: string }[] }>().items.map((p) => p.id)).toEqual([postA]);

    for (const url of ['/api/v1/posts', `/api/v1/posts/${postB}`]) {
      const res = await app.inject({ url, headers: asMember(alice, orgB) });
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain('Post de B');
    }
    const write = await app.inject({
      method: 'PATCH',
      url: `/api/v1/posts/${postB}`,
      headers: asMember(alice, orgB),
      payload: { body: 'hacked' },
    });
    expect(write.statusCode).toBe(403);
  });

  it('/me lists only the organizations the user belongs to', async () => {
    const carol = await signUp('Carol');
    const dave = await signUp('Dave');
    const orgC = await createOrganization(carol, 'Carol & Co');
    await createOrganization(dave, 'Dave Media');

    const me = await app.inject({ url: '/api/v1/me', headers: { cookie: carol.cookie } });

    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      user: { id: carol.userId, name: 'Carol' },
      organizations: [{ organizationId: orgC, name: 'Carol & Co', role: 'owner' }],
    });
  });

  it('an organization route without x-organization-id is refused (400), never run unscoped', async () => {
    const erin = await signUp('Erin');
    const res = await app.inject({ url: '/api/v1/posts', headers: { cookie: erin.cookie } });
    expect(res.statusCode).toBe(400);
  });
});

describe('sessions', () => {
  it('sign-up sets an httpOnly SameSite=Lax cookie and never returns the session token or password', async () => {
    const frank = await signUp('Frank');

    const session = frank.setCookie.find((c) => c.startsWith('ponctua.session_token='));
    expect(session).toBeDefined();
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    expect(JSON.parse(frank.body)).not.toHaveProperty('token');
    expect(frank.body).not.toContain(PASSWORD);
  });

  it('no cookie or a forged cookie -> 401', async () => {
    expect((await app.inject({ url: '/api/v1/me' })).statusCode).toBe(401);
    const forged = await app.inject({
      url: '/api/v1/me',
      headers: { cookie: 'ponctua.session_token=forged.signature' },
    });
    expect(forged.statusCode).toBe(401);
  });

  it('after sign-out the old cookie no longer works', async () => {
    const grace = await signUp('Grace');
    const out = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: { cookie: grace.cookie, origin: 'http://localhost:5173' },
    });
    expect(out.statusCode).toBe(200);

    expect(
      (await app.inject({ url: '/api/v1/me', headers: { cookie: grace.cookie } })).statusCode,
    ).toBe(401);
  });

  it('refuses passwords shorter than 12 characters', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { origin: 'http://localhost:5173' },
      payload: {
        name: 'Short',
        email: `short-${randomUUIDv7()}@test.ponctua.local`,
        password: 'short-pass',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('the removed development header (ADR 003) grants nothing', async () => {
    const org = await createOrganization(await signUp('Heidi'), 'Heidi Studio');
    const res = await app.inject({
      url: '/api/v1/posts',
      headers: { 'x-dev-organization-id': org },
    });
    expect(res.statusCode).toBe(401);
  });

  it('passwords and session tokens never reach the logs', async () => {
    const ivan = await signUp('Ivan');
    await app.inject({ url: '/api/v1/me', headers: { cookie: ivan.cookie } });

    const output = logs.raw.join('');
    expect(output).not.toContain(PASSWORD);
    expect(output).not.toContain(ivan.cookie.split('=')[1] ?? 'unreachable');
  });
});

describe('brute-force protection', () => {
  it('limits sign-in attempts per address, and a forged client-ip header does not reset the count', async () => {
    const limited = await createTestApp({
      env: createTestEnv({ AUTH_RATE_LIMIT: 'true' }),
    });
    try {
      const attempt = (forgedIp: string) =>
        limited.inject({
          method: 'POST',
          url: '/api/auth/sign-in/email',
          headers: {
            origin: 'http://localhost:5173',
            [CLIENT_IP_HEADER]: forgedIp,
            'x-forwarded-for': forgedIp,
          },
          payload: { email: 'nobody@test.ponctua.local', password: 'wrong-password-123' },
        });

      for (let i = 0; i < SIGN_IN_LIMIT; i++) {
        expect((await attempt(`203.0.113.${String(i)}`)).statusCode).toBe(401);
      }
      expect((await attempt('198.51.100.7')).statusCode).toBe(429);
    } finally {
      await limited.close();
    }
  });
});

describe('error codes the web app relies on', () => {
  it('wrong password and unknown email give the same answer (no account probing)', async () => {
    const judy = await signUp('Judy');
    const me = await app.inject({ url: '/api/v1/me', headers: { cookie: judy.cookie } });
    const email = me.json<{ user: { email: string } }>().user.email;
    const signIn = (address: string) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: { origin: 'http://localhost:5173' },
        payload: { email: address, password: 'wrong-password-123' },
      });

    const wrongPassword = await signIn(email);
    const unknownEmail = await signIn(`nobody-${randomUUIDv7()}@test.ponctua.local`);

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPassword.json()).toMatchObject({ code: 'INVALID_EMAIL_OR_PASSWORD' });
    expect(unknownEmail.json()).toEqual(wrongPassword.json());
  });

  it('a second sign-up with the same email is refused with a stable code', async () => {
    const email = `kim-${randomUUIDv7()}@test.ponctua.local`;
    const signUpWith = () =>
      app.inject({
        method: 'POST',
        url: '/api/auth/sign-up/email',
        headers: { origin: 'http://localhost:5173' },
        payload: { name: 'Kim', email, password: PASSWORD },
      });

    expect((await signUpWith()).statusCode).toBe(200);
    const again = await signUpWith();
    expect(again.statusCode).toBe(422);
    expect(again.json()).toMatchObject({ code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL' });
  });

  it('a short password is refused with PASSWORD_TOO_SHORT', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { origin: 'http://localhost:5173' },
      payload: {
        name: 'Leo',
        email: `leo-${randomUUIDv7()}@test.ponctua.local`,
        password: 'short',
      },
    });
    expect(res.json()).toMatchObject({ code: 'PASSWORD_TOO_SHORT' });
  });

  // Better Auth checks the origin when the request carries a cookie or Fetch Metadata headers, which
  // every current browser sends: a cross-site page cannot sign someone up or in (CSRF).
  it('a browser request from an untrusted origin is refused', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: {
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
      },
      payload: {
        name: 'Eve',
        email: `eve-${randomUUIDv7()}@test.ponctua.local`,
        password: PASSWORD,
      },
    });
    expect(res.statusCode).toBe(403);
  });
});
