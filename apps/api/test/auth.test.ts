import { createDb, type Db } from '@ponctua/db';
import { createIdentityClient, type IdentityClient } from '@ponctua/db/identity';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  CLIENT_IP_HEADER,
  EMAIL_SEND_LIMIT,
  EMAIL_VERIFIED_PATH,
  RESET_PASSWORD_PATH,
  SIGN_IN_LIMIT,
} from '../src/modules/identity/auth.js';
import {
  asMember,
  cookieFrom,
  createLogCapture,
  createTestApp,
  createTestEnv,
  mailbox,
  signUpUser,
  TEST_PASSWORD,
  type TestUser,
  uniqueEmail,
  WEB_ORIGIN,
} from './helpers.js';

let app: NestFastifyApplication;
let db: Db;
let identity: IdentityClient;
const logs = createLogCapture();

const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, headers: { origin: WEB_ORIGIN, ...headers }, payload });

const signUpRequest = (email: string, password = TEST_PASSWORD) =>
  post('/api/auth/sign-up/email', {
    name: 'Someone',
    email,
    password,
    callbackURL: EMAIL_VERIFIED_PATH,
  });

const signIn = (email: string, password = TEST_PASSWORD) =>
  post('/api/auth/sign-in/email', { email, password });

const me = (user: Pick<TestUser, 'cookie'>) =>
  app.inject({ url: '/api/v1/me', headers: { cookie: user.cookie } });

async function createOrganization(user: TestUser, name: string): Promise<string> {
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
    const created = await tx.post.create({
      data: { organizationId, workspaceId: workspace.id, body },
    });
    return created.id;
  });
}

beforeAll(async () => {
  db = createDb({ connectionString: inject('databaseUrl') });
  identity = createIdentityClient(inject('authDatabaseUrl'));
  app = await createTestApp({ logStream: logs.stream });
});

afterAll(async () => {
  await app.close();
  await db.disconnect();
  await identity.$disconnect();
});

describe('organizations are isolated between signed-in users (multi-tenant first)', () => {
  it('a member of A gets 403 on B, even with a valid session; data of A stays readable for A only', async () => {
    const alice = await signUpUser(app, 'Alice');
    const bob = await signUpUser(app, 'Bob');
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
    const carol = await signUpUser(app, 'Carol');
    const dave = await signUpUser(app, 'Dave');
    const orgC = await createOrganization(carol, 'Carol & Co');
    await createOrganization(dave, 'Dave Media');

    const res = await me(carol);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      user: { id: carol.userId, name: 'Carol' },
      organizations: [{ organizationId: orgC, name: 'Carol & Co', role: 'owner' }],
    });
  });

  it('an organization route without x-organization-id is refused (400), never run unscoped', async () => {
    const erin = await signUpUser(app, 'Erin');
    const res = await app.inject({ url: '/api/v1/posts', headers: { cookie: erin.cookie } });
    expect(res.statusCode).toBe(400);
  });
});

describe('email verification (required before any session)', () => {
  it('sign-up opens no session and emails a verification link', async () => {
    const email = uniqueEmail('Frank');
    const res = await signUpRequest(email);

    expect(res.statusCode).toBe(200);
    expect(cookieFrom(res.headers['set-cookie'])).not.toContain('session_token');
    expect(JSON.parse(res.body)).not.toHaveProperty('token');
    expect(res.body).not.toContain(TEST_PASSWORD);
    const [message] = mailbox.to(email);
    expect(message?.subject).toBe('Confirmez votre adresse courriel — Ponctua');
    expect(message?.text).toContain('/api/auth/verify-email?token=');
  });

  it('signing in before verifying is refused (403) and sends a fresh link', async () => {
    const email = uniqueEmail('Grace');
    await signUpRequest(email);

    const res = await signIn(email);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
    expect(cookieFrom(res.headers['set-cookie'])).not.toContain('session_token');
    expect(mailbox.to(email)).toHaveLength(2);
  });

  it('the link verifies the address and signs in with an httpOnly SameSite=Lax cookie', async () => {
    const email = uniqueEmail('Heidi');
    await signUpRequest(email);

    const res = await app.inject({ url: mailbox.linkFor(email) });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(EMAIL_VERIFIED_PATH);
    const raw = res.headers['set-cookie'];
    const session = (Array.isArray(raw) ? raw : [raw ?? '']).find((c) =>
      c.startsWith('ponctua.session_token='),
    );
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    expect((await me({ cookie: cookieFrom(raw) })).statusCode).toBe(200);
    // And from now on the password works.
    expect((await signIn(email)).statusCode).toBe(200);
  });

  it('a tampered link verifies nothing and opens no session', async () => {
    const email = uniqueEmail('Ivan');
    await signUpRequest(email);
    const link = mailbox.linkFor(email).replace(/token=([^&]+)/, 'token=$1x');

    const res = await app.inject({ url: link });

    expect(cookieFrom(res.headers['set-cookie'])).not.toContain('session_token');
    expect((await signIn(email)).statusCode).toBe(403);
  });

  it('signing up with an address that has an account looks the same, and warns the owner', async () => {
    const judy = await signUpUser(app, 'Judy');
    const before = mailbox.to(judy.email).length;

    const again = await signUpRequest(judy.email, 'another-password-123');
    const fresh = await signUpRequest(uniqueEmail('Nobody'));

    // Same status and same shape: an attacker cannot tell which address has an account.
    expect(again.statusCode).toBe(fresh.statusCode);
    expect(Object.keys(again.json<{ user: object }>().user).sort()).toEqual(
      Object.keys(fresh.json<{ user: object }>().user).sort(),
    );
    expect(again.json<{ user: { id: string } }>().user.id).not.toBe(judy.userId);
    const warning = mailbox.to(judy.email).slice(before);
    expect(warning.map((m) => m.subject)).toEqual(['Tentative de création de compte — Ponctua']);
    // The original password still works; the attempt changed nothing.
    expect((await signIn(judy.email)).statusCode).toBe(200);
    expect(await identity.user.count({ where: { email: judy.email } })).toBe(1);
  });

  it('emails carry no text typed at sign-up (the name), and follow the browser language', async () => {
    const email = uniqueEmail('Mallory');
    await post(
      '/api/auth/sign-up/email',
      { name: '<b>Click http://evil.example</b>', email, password: TEST_PASSWORD },
      { 'accept-language': 'en-CA,en;q=0.9' },
    );

    const [message] = mailbox.to(email);
    expect(message?.subject).toBe('Confirm your email address — Ponctua');
    expect(message?.html).toContain('lang="en"');
    expect(`${message?.text ?? ''}${message?.html ?? ''}`).not.toContain('evil.example');
  });
});

describe('password reset', () => {
  it('answers the same for an unknown address, and emails only real accounts', async () => {
    const kim = await signUpUser(app, 'Kim');
    const unknown = uniqueEmail('Ghost');
    const before = mailbox.sent.length;

    const known = await post('/api/auth/request-password-reset', {
      email: kim.email,
      redirectTo: RESET_PASSWORD_PATH,
    });
    const missing = await post('/api/auth/request-password-reset', {
      email: unknown,
      redirectTo: RESET_PASSWORD_PATH,
    });

    expect(known.statusCode).toBe(200);
    expect(missing.statusCode).toBe(200);
    expect(missing.json()).toEqual(known.json());
    expect(mailbox.sent.slice(before).map((m) => m.to)).toEqual([kim.email]);
  });

  it('the link sets a new password once, signs out every session and notifies the owner', async () => {
    const leo = await signUpUser(app, 'Leo');
    await post('/api/auth/request-password-reset', {
      email: leo.email,
      redirectTo: RESET_PASSWORD_PATH,
    });

    // The emailed link redirects to the web page with the token.
    const opened = await app.inject({ url: mailbox.linkFor(leo.email) });
    expect(opened.statusCode).toBe(302);
    const target = new URL(opened.headers.location ?? '', WEB_ORIGIN);
    expect(target.pathname).toBe(RESET_PASSWORD_PATH);
    const token = target.searchParams.get('token') ?? '';
    expect(token).not.toBe('');

    // Stored hashed: the database never holds the token that works.
    const rows = await identity.verification.findMany({
      where: { identifier: { contains: token } },
    });
    expect(rows).toHaveLength(0);

    const newPassword = 'a-brand-new-passphrase';
    const reset = await post('/api/auth/reset-password', { token, newPassword });
    expect(reset.statusCode).toBe(200);

    expect((await me(leo)).statusCode).toBe(401);
    expect((await signIn(leo.email)).statusCode).toBe(401);
    expect((await signIn(leo.email, newPassword)).statusCode).toBe(200);
    const reused = await post('/api/auth/reset-password', {
      token,
      newPassword: 'yet-another-pass-1',
    });
    expect(reused.statusCode).toBe(400);
    expect(mailbox.to(leo.email).at(-1)?.subject).toBe(
      'Votre mot de passe a été modifié — Ponctua',
    );
  });
});

describe('sessions', () => {
  it('no cookie or a forged cookie -> 401', async () => {
    expect((await app.inject({ url: '/api/v1/me' })).statusCode).toBe(401);
    expect((await me({ cookie: 'ponctua.session_token=forged.signature' })).statusCode).toBe(401);
  });

  it('after sign-out the old cookie no longer works', async () => {
    const mia = await signUpUser(app, 'Mia');
    const out = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: { cookie: mia.cookie, origin: WEB_ORIGIN },
    });
    expect(out.statusCode).toBe(200);

    expect((await me(mia)).statusCode).toBe(401);
  });

  it('refuses passwords shorter than 12 characters', async () => {
    const res = await signUpRequest(uniqueEmail('Short'), 'short-pass');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'PASSWORD_TOO_SHORT' });
  });

  it('the removed development header (ADR 003) grants nothing', async () => {
    const org = await createOrganization(await signUpUser(app, 'Nina'), 'Nina Studio');
    const res = await app.inject({
      url: '/api/v1/posts',
      headers: { 'x-dev-organization-id': org },
    });
    expect(res.statusCode).toBe(401);
  });

  it('wrong password and unknown email give the same answer (no account probing)', async () => {
    const oscar = await signUpUser(app, 'Oscar');

    const wrongPassword = await signIn(oscar.email, 'wrong-password-123');
    const unknownEmail = await signIn(uniqueEmail('Nobody'), 'wrong-password-123');

    expect(wrongPassword.statusCode).toBe(401);
    expect(wrongPassword.json()).toMatchObject({ code: 'INVALID_EMAIL_OR_PASSWORD' });
    expect(unknownEmail.json()).toEqual(wrongPassword.json());
  });

  // Better Auth checks the origin when the request carries a cookie or Fetch Metadata headers, which
  // every current browser sends: a cross-site page cannot sign someone up or in (CSRF).
  it('a browser request from an untrusted origin is refused', async () => {
    const res = await post(
      '/api/auth/sign-up/email',
      { name: 'Eve', email: uniqueEmail('Eve'), password: TEST_PASSWORD },
      {
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
      },
    );
    expect(res.statusCode).toBe(403);
  });

  it('passwords, session tokens, emailed tokens and addresses never reach the logs', async () => {
    const paul = await signUpUser(app, 'Paul');
    await me(paul);
    await post('/api/auth/request-password-reset', { email: paul.email });
    await signIn(paul.email, 'wrong-password-123');

    const output = logs.raw.join('');
    expect(output).not.toContain(TEST_PASSWORD);
    expect(output).not.toContain(paul.cookie.split('=')[1] ?? 'unreachable');
    for (const message of mailbox.to(paul.email)) {
      const token = /token=([^&\s]+)|reset-password\/([^?\s]+)/.exec(message.text);
      expect(output).not.toContain(token?.[1] ?? token?.[2] ?? 'unreachable');
    }
    expect(output).not.toContain(paul.email);
  });
});

describe('brute-force protection', () => {
  async function withLimits(run: (limited: NestFastifyApplication) => Promise<void>) {
    const limited = await createTestApp({ env: createTestEnv({ AUTH_RATE_LIMIT: 'true' }) });
    try {
      await run(limited);
    } finally {
      await limited.close();
    }
  }

  it('limits sign-in attempts per address, and a forged client-ip header does not reset the count', async () => {
    await withLimits(async (limited) => {
      const attempt = (forgedIp: string) =>
        limited.inject({
          method: 'POST',
          url: '/api/auth/sign-in/email',
          headers: {
            origin: WEB_ORIGIN,
            [CLIENT_IP_HEADER]: forgedIp,
            'x-forwarded-for': forgedIp,
          },
          payload: { email: 'nobody@test.ponctua.local', password: 'wrong-password-123' },
        });

      for (let i = 0; i < SIGN_IN_LIMIT; i++) {
        expect((await attempt(`203.0.113.${String(i)}`)).statusCode).toBe(401);
      }
      expect((await attempt('198.51.100.7')).statusCode).toBe(429);
    });
  });

  it('limits password-reset emails per address (no mail bombing)', async () => {
    await withLimits(async (limited) => {
      const request = () =>
        limited.inject({
          method: 'POST',
          url: '/api/auth/request-password-reset',
          headers: { origin: WEB_ORIGIN },
          payload: { email: uniqueEmail('Target') },
        });
      for (let i = 0; i < EMAIL_SEND_LIMIT; i++) expect((await request()).statusCode).toBe(200);
      expect((await request()).statusCode).toBe(429);
    });
  });
});
