import { createDb, type Db } from '@ponctua/db';
import { createIdentityClient, type IdentityClient } from '@ponctua/db/identity';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { TOTP_ISSUER } from '../src/modules/identity/auth.js';
import {
  addMember,
  asMember,
  cookieFrom,
  createLogCapture,
  createTestApp,
  mailbox,
  signUpUser,
  TEST_PASSWORD,
  type TestUser,
  WEB_ORIGIN,
} from './helpers.js';
import { totpCode } from './totp.js';

let app: NestFastifyApplication;
let db: Db;
let identity: IdentityClient;
const logs = createLogCapture();

const post = (url: string, payload: object, cookie?: string) =>
  app.inject({
    method: 'POST',
    url,
    headers: { origin: WEB_ORIGIN, ...(cookie ? { cookie } : {}) },
    payload,
  });

const me = (cookie: string) => app.inject({ url: '/api/v1/me', headers: { cookie } });

const hasSession = (setCookie: string | string[] | undefined) =>
  /ponctua\.session_token=[^;\s]+/.test(cookieFrom(setCookie));

interface Enabled {
  user: TestUser;
  totpURI: string;
  backupCodes: string[];
}

/** The real path: password, then the QR code / key, then a first code from the app. */
async function enableTwoFactor(name: string): Promise<Enabled> {
  const user = await signUpUser(app, name);
  const enabled = await post(
    '/api/auth/two-factor/enable',
    { password: TEST_PASSWORD },
    user.cookie,
  );
  expect(enabled.statusCode).toBe(200);
  const { totpURI, backupCodes } = enabled.json<{ totpURI: string; backupCodes: string[] }>();
  const verified = await post(
    '/api/auth/two-factor/verify-totp',
    { code: totpCode(totpURI) },
    user.cookie,
  );
  expect(verified.statusCode).toBe(200);
  // Enabling issues a new session: keep the cookie the browser would now hold.
  const cookie = cookieFrom(verified.headers['set-cookie']) || user.cookie;
  return { user: { ...user, cookie }, totpURI, backupCodes };
}

/** First step of sign-in: the password. With 2FA on, it gives only the short-lived 2FA cookie. */
async function signInPassword(email: string, cookie?: string) {
  return post('/api/auth/sign-in/email', { email, password: TEST_PASSWORD }, cookie);
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

describe('a pending second step grants nothing (multi-tenant first)', () => {
  it('after the password alone, no organization data and no /me', async () => {
    const { user } = await enableTwoFactor('Ada');
    const organization = await db.createOrganization({ name: 'Ada Agency' });
    await db.withTenant(organization.id, (tx) =>
      tx.workspace.create({ data: { organizationId: organization.id, name: 'Main' } }),
    );
    await addMember(db, organization.id, user);

    const step1 = await signInPassword(user.email);

    expect(step1.statusCode).toBe(200);
    expect(step1.json()).toMatchObject({ twoFactorRedirect: true, twoFactorMethods: ['totp'] });
    expect(hasSession(step1.headers['set-cookie'])).toBe(false);
    const pending = cookieFrom(step1.headers['set-cookie']);
    expect((await me(pending)).statusCode).toBe(401);
    const posts = await app.inject({
      url: '/api/v1/posts',
      headers: { ...asMember({ ...user, cookie: pending }, organization.id) },
    });
    expect(posts.statusCode).toBe(401);
  });
});

describe('enabling two-factor authentication', () => {
  it('needs a session and the current password', async () => {
    const user = await signUpUser(app, 'Bea');

    expect(
      (await post('/api/auth/two-factor/enable', { password: TEST_PASSWORD })).statusCode,
    ).toBe(401);
    const wrong = await post(
      '/api/auth/two-factor/enable',
      { password: 'not-my-password' },
      user.cookie,
    );
    expect(wrong.statusCode).toBe(400);
  });

  it('gives an otpauth URI for the app and 10 backup codes; only a valid first code turns it on', async () => {
    const user = await signUpUser(app, 'Cleo');
    const enabled = await post(
      '/api/auth/two-factor/enable',
      { password: TEST_PASSWORD },
      user.cookie,
    );
    const { totpURI, backupCodes } = enabled.json<{ totpURI: string; backupCodes: string[] }>();

    const uri = new URL(totpURI);
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.searchParams.get('issuer')).toBe(TOTP_ISSUER);
    expect(backupCodes).toHaveLength(10);
    expect(new Set(backupCodes).size).toBe(10);

    // Not on yet: a wrong first code changes nothing, sign-in still needs the password only.
    const wrong = await post('/api/auth/two-factor/verify-totp', { code: '000000' }, user.cookie);
    expect(wrong.statusCode).not.toBe(200);
    expect((await signInPassword(user.email)).json()).not.toHaveProperty('twoFactorRedirect');

    await post('/api/auth/two-factor/verify-totp', { code: totpCode(totpURI) }, user.cookie);
    expect((await signInPassword(user.email)).json()).toMatchObject({ twoFactorRedirect: true });
  });

  it('stores the secret and the backup codes encrypted, never as given to the user', async () => {
    const { user, totpURI, backupCodes } = await enableTwoFactor('Dora');
    const secret = new URL(totpURI).searchParams.get('secret') ?? 'unreachable';

    const row = await identity.twoFactor.findUniqueOrThrow({ where: { userId: user.userId } });

    expect(row.secret).not.toContain(secret);
    for (const code of backupCodes) expect(row.backupCodes).not.toContain(code);
  });
});

describe('signing in with two-factor authentication', () => {
  it('the code from the app completes sign-in; a wrong code does not', async () => {
    const { user, totpURI } = await enableTwoFactor('Eli');
    const pending = cookieFrom((await signInPassword(user.email)).headers['set-cookie']);

    const wrong = await post('/api/auth/two-factor/verify-totp', { code: '123456' }, pending);
    expect(wrong.statusCode).not.toBe(200);
    expect(hasSession(wrong.headers['set-cookie'])).toBe(false);

    const ok = await post('/api/auth/two-factor/verify-totp', { code: totpCode(totpURI) }, pending);
    expect(ok.statusCode).toBe(200);
    expect(hasSession(ok.headers['set-cookie'])).toBe(true);
    expect((await me(cookieFrom(ok.headers['set-cookie']))).statusCode).toBe(200);
  });

  it('a backup code works once', async () => {
    const { user, backupCodes } = await enableTwoFactor('Fay');
    const [code] = backupCodes;

    const first = cookieFrom((await signInPassword(user.email)).headers['set-cookie']);
    const used = await post('/api/auth/two-factor/verify-backup-code', { code }, first);
    expect(used.statusCode).toBe(200);
    expect(hasSession(used.headers['set-cookie'])).toBe(true);

    const second = cookieFrom((await signInPassword(user.email)).headers['set-cookie']);
    const reused = await post('/api/auth/two-factor/verify-backup-code', { code }, second);
    expect(reused.statusCode).not.toBe(200);
    expect(hasSession(reused.headers['set-cookie'])).toBe(false);
  });

  it('"trust this device" skips the code on that browser only', async () => {
    const { user, totpURI } = await enableTwoFactor('Gus');
    const pending = cookieFrom((await signInPassword(user.email)).headers['set-cookie']);
    const trusted = await post(
      '/api/auth/two-factor/verify-totp',
      { code: totpCode(totpURI), trustDevice: true },
      pending,
    );
    const trustCookie = cookieFrom(trusted.headers['set-cookie'])
      .split('; ')
      .filter((c) => c.startsWith('ponctua.trust_device='))
      .join('; ');
    expect(trustCookie).not.toBe('');

    const sameBrowser = await signInPassword(user.email, trustCookie);
    expect(sameBrowser.json()).not.toHaveProperty('twoFactorRedirect');
    expect(hasSession(sameBrowser.headers['set-cookie'])).toBe(true);

    const otherBrowser = await signInPassword(user.email);
    expect(otherBrowser.json()).toMatchObject({ twoFactorRedirect: true });
  });
});

describe('turning two-factor off and changing the password', () => {
  it('turning it off needs the password and warns the owner by email', async () => {
    const { user } = await enableTwoFactor('Hal');

    const wrong = await post(
      '/api/auth/two-factor/disable',
      { password: 'nope-nope-nope' },
      user.cookie,
    );
    expect(wrong.statusCode).toBe(400);
    const off = await post(
      '/api/auth/two-factor/disable',
      { password: TEST_PASSWORD },
      user.cookie,
    );
    expect(off.statusCode).toBe(200);

    expect((await signInPassword(user.email)).json()).not.toHaveProperty('twoFactorRedirect');
    expect(mailbox.to(user.email).at(-1)?.subject).toBe(
      'Double authentification désactivée — Ponctua',
    );
  });

  it('changing the password needs the current one, signs out other sessions and warns by email', async () => {
    const user = await signUpUser(app, 'Ivy');
    const otherDevice = cookieFrom((await signInPassword(user.email)).headers['set-cookie']);
    expect((await me(otherDevice)).statusCode).toBe(200);

    const wrong = await post(
      '/api/auth/change-password',
      { currentPassword: 'not-it-at-all', newPassword: 'a-brand-new-passphrase' },
      user.cookie,
    );
    expect(wrong.statusCode).toBe(400);

    const changed = await post(
      '/api/auth/change-password',
      {
        currentPassword: TEST_PASSWORD,
        newPassword: 'a-brand-new-passphrase',
        revokeOtherSessions: true,
      },
      user.cookie,
    );
    expect(changed.statusCode).toBe(200);
    expect(JSON.parse(changed.body)).not.toHaveProperty('token');

    expect((await me(otherDevice)).statusCode).toBe(401);
    expect((await me(cookieFrom(changed.headers['set-cookie']))).statusCode).toBe(200);
    expect(mailbox.to(user.email).at(-1)?.subject).toBe(
      'Votre mot de passe a été modifié — Ponctua',
    );
  });
});

describe('secrets stay out of the logs', () => {
  it('no TOTP secret, code or backup code is ever logged', async () => {
    const { user, totpURI, backupCodes } = await enableTwoFactor('Jo');
    const code = totpCode(totpURI);
    const pending = cookieFrom((await signInPassword(user.email)).headers['set-cookie']);
    await post('/api/auth/two-factor/verify-totp', { code }, pending);

    const output = logs.raw.join('');
    expect(output).not.toContain(new URL(totpURI).searchParams.get('secret') ?? 'unreachable');
    for (const backup of backupCodes) expect(output).not.toContain(backup);
    expect(output).not.toContain(user.email);
  });
});
