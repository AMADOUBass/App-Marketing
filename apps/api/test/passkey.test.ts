import { createDb, type Db } from '@ponctua/db';
import { createIdentityClient, type IdentityClient } from '@ponctua/db/identity';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PASSKEY_FRESH_SESSION_SECONDS } from '../src/modules/identity/auth.js';
import {
  addMember,
  asMember,
  cookieFrom,
  createLogCapture,
  createTestApp,
  mailbox,
  signUpUser,
  type TestUser,
  WEB_ORIGIN,
} from './helpers.js';
import { type CeremonyOptions, SoftwarePasskey } from './webauthn.js';

let app: NestFastifyApplication;
let db: Db;
let identity: IdentityClient;
const logs = createLogCapture();

const newPasskey = () => new SoftwarePasskey('localhost', WEB_ORIGIN);
const hasSession = (setCookie: string | string[] | undefined) =>
  /ponctua\.session_token=[^;\s]+/.test(cookieFrom(setCookie));
const join = (...cookies: string[]) => cookies.filter(Boolean).join('; ');

/** Registration: options (challenge + its cookie), then the authenticator's answer. */
async function register(user: TestUser, key: SoftwarePasskey, options: CeremonyOptions = {}) {
  const started = await app.inject({
    url: '/api/auth/passkey/generate-register-options',
    headers: { cookie: user.cookie },
  });
  if (started.statusCode !== 200) return started;
  const { challenge } = started.json<{ challenge: string }>();
  return app.inject({
    method: 'POST',
    url: '/api/auth/passkey/verify-registration',
    headers: {
      origin: WEB_ORIGIN,
      cookie: join(user.cookie, cookieFrom(started.headers['set-cookie'])),
    },
    payload: { response: key.register(challenge, options), name: 'Test passkey' },
  });
}

/** Sign-in: no address typed; the authenticator picks its credential (discoverable passkey). */
async function signInWithPasskey(key: SoftwarePasskey, options: CeremonyOptions = {}) {
  const started = await app.inject({ url: '/api/auth/passkey/generate-authenticate-options' });
  const { challenge } = started.json<{ challenge: string }>();
  return app.inject({
    method: 'POST',
    url: '/api/auth/passkey/verify-authentication',
    headers: { origin: WEB_ORIGIN, cookie: cookieFrom(started.headers['set-cookie']) },
    payload: { response: key.authenticate(challenge, options) },
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

describe('a passkey signs in its owner only (multi-tenant first)', () => {
  it('the session belongs to the passkey owner: own organization yes, another one 403', async () => {
    const owner = await signUpUser(app, 'Ana');
    const stranger = await signUpUser(app, 'Ben');
    const mine = await db.createOrganization({ name: 'Ana Agency' });
    const theirs = await db.createOrganization({ name: 'Ben Agency' });
    for (const id of [mine.id, theirs.id]) {
      await db.withTenant(id, (tx) =>
        tx.workspace.create({ data: { organizationId: id, name: 'Main' } }),
      );
    }
    await addMember(db, mine.id, owner);
    await addMember(db, theirs.id, stranger);
    const key = newPasskey();
    expect((await register(owner, key)).statusCode).toBe(200);

    const signedIn = await signInWithPasskey(key);

    expect(signedIn.statusCode).toBe(200);
    const session = { ...owner, cookie: cookieFrom(signedIn.headers['set-cookie']) };
    const me = await app.inject({ url: '/api/v1/me', headers: { cookie: session.cookie } });
    expect(me.json()).toMatchObject({ user: { id: owner.userId } });
    expect(
      (await app.inject({ url: '/api/v1/posts', headers: asMember(session, mine.id) })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: '/api/v1/posts', headers: asMember(session, theirs.id) }))
        .statusCode,
    ).toBe(403);
  });
});

describe('adding a passkey', () => {
  it('needs a session, and a recent one (signed in within the last minutes)', async () => {
    const anonymous = await app.inject({ url: '/api/auth/passkey/generate-register-options' });
    expect(anonymous.statusCode).toBe(401);

    const user = await signUpUser(app, 'Cy');
    const old = new Date(Date.now() - (PASSKEY_FRESH_SESSION_SECONDS + 60) * 1000);
    await identity.session.updateMany({ where: { userId: user.userId }, data: { createdAt: old } });

    const stale = await register(user, newPasskey());

    expect(stale.statusCode).toBe(403);
    expect(stale.json()).toMatchObject({ code: 'SESSION_NOT_FRESH' });
    expect(await identity.passkey.count({ where: { userId: user.userId } })).toBe(0);
  });

  it('refuses an authenticator that did not verify the user (no PIN, no biometrics)', async () => {
    const user = await signUpUser(app, 'Dee');

    const res = await register(user, newPasskey(), { userVerified: false });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'USER_VERIFICATION_REQUIRED' });
    expect(await identity.passkey.count({ where: { userId: user.userId } })).toBe(0);
  });

  it('refuses a registration made from another origin', async () => {
    const user = await signUpUser(app, 'Eve');

    const res = await register(user, newPasskey(), { origin: 'https://evil.example' });

    expect(res.statusCode).not.toBe(200);
    expect(await identity.passkey.count({ where: { userId: user.userId } })).toBe(0);
  });

  it('stores the public key only, lists it, and warns the owner by email', async () => {
    const user = await signUpUser(app, 'Fin');
    const key = newPasskey();

    const res = await register(user, key);

    expect(res.statusCode).toBe(200);
    const stored = await identity.passkey.findFirstOrThrow({ where: { userId: user.userId } });
    expect(stored.credentialID).toBe(key.id);
    expect(stored.name).toBe('Test passkey');
    const list = await app.inject({
      url: '/api/auth/passkey/list-user-passkeys',
      headers: { cookie: user.cookie },
    });
    expect(list.json<{ id: string }[]>().map((p) => p.id)).toEqual([stored.id]);
    expect(mailbox.to(user.email).at(-1)?.subject).toBe('Nouvelle passkey ajoutée — Ponctua');
  });
});

describe('signing in with a passkey', () => {
  it('opens a session (cookie only: no token in the JSON body)', async () => {
    const user = await signUpUser(app, 'Gil');
    const key = newPasskey();
    await register(user, key);

    const res = await signInWithPasskey(key);

    expect(res.statusCode).toBe(200);
    expect(hasSession(res.headers['set-cookie'])).toBe(true);
    const body = res.json<{ session?: Record<string, unknown> }>();
    expect(body).not.toHaveProperty('token');
    expect(body.session).not.toHaveProperty('token');
  });

  it('is refused without user verification, with another origin, or with an unknown key', async () => {
    const user = await signUpUser(app, 'Hon');
    const key = newPasskey();
    await register(user, key);

    const withoutVerification = await signInWithPasskey(key, { userVerified: false });
    expect(withoutVerification.json()).toMatchObject({ code: 'USER_VERIFICATION_REQUIRED' });

    for (const attempt of [
      withoutVerification,
      await signInWithPasskey(key, { origin: 'https://evil.example' }),
      await signInWithPasskey(newPasskey()),
    ]) {
      expect(attempt.statusCode).not.toBe(200);
      expect(hasSession(attempt.headers['set-cookie'])).toBe(false);
    }
  });

  it('a removed passkey no longer signs in, and the owner is told', async () => {
    const user = await signUpUser(app, 'Ike');
    const key = newPasskey();
    await register(user, key);
    const stored = await identity.passkey.findFirstOrThrow({ where: { userId: user.userId } });

    const removed = await app.inject({
      method: 'POST',
      url: '/api/auth/passkey/delete-passkey',
      headers: { origin: WEB_ORIGIN, cookie: user.cookie },
      payload: { id: stored.id },
    });

    expect(removed.statusCode).toBe(200);
    expect((await signInWithPasskey(key)).statusCode).not.toBe(200);
    expect(mailbox.to(user.email).at(-1)?.subject).toBe('Passkey supprimée — Ponctua');
  });
});

describe('session tokens stay in the cookie', () => {
  it('get-session (exposed by Better Auth) returns no token either', async () => {
    const user = await signUpUser(app, 'Jay');

    const res = await app.inject({
      url: '/api/auth/get-session',
      headers: { cookie: user.cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ session?: Record<string, unknown> }>();
    expect(body.session).toBeDefined();
    expect(body.session).not.toHaveProperty('token');
    expect(res.body).not.toContain(user.cookie.split('=')[1]?.split('.')[0] ?? 'unreachable');
  });
});
