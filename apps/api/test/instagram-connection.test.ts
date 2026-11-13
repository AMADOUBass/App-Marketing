import { generateKeyPairSync } from 'node:crypto';
import { createDb, type Db } from '@app/db';
import type { FetchLike } from '@app/integrations';
import { createVaultOpener } from '@app/vault/open';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { DEV_TENANT_HEADER } from '../src/common/tenant.js';
import { verifyOAuthState } from '../src/modules/integrations/oauth-state.js';
import { createLogCapture, createTestApp, createTestEnv } from './helpers.js';

const IG_ACCOUNT_ID = '17841472428926955';
const ACCESS_TOKEN = 'EAAG-system-user-token-never-in-clear';
const APP_SECRET = 'meta-app-secret-value-never-logged';
const STATE_SECRET = 'state-signing-key-0123456789abcdef0123456789';

function masterKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKey: publicKey.export({ format: 'jwk' }).x ?? '',
    privateKey: privateKey.export({ format: 'jwk' }).d ?? '',
  };
}
const master = masterKeyPair();

const instagramEnv = {
  META_APP_ID: '1604528421424442',
  META_APP_SECRET: APP_SECRET,
  INSTAGRAM_CONFIG_ID: '987654321',
  INSTAGRAM_REDIRECT_URI: 'https://tunnel.example.com/api/v1/integrations/instagram/callback',
  OAUTH_STATE_SECRET: STATE_SECRET,
  VAULT_MASTER_KEY_ID: 'mk-test',
  VAULT_MASTER_PUBLIC_KEY: master.publicKey,
  WEB_APP_URL: 'https://tunnel.example.com',
};

/** Fake Graph API: code exchange + assigned accounts. Records calls. */
function fakeGraph(options: { exchangeFails?: boolean } = {}) {
  const calls: string[] = [];
  const fetchImpl: FetchLike = (input) => {
    const url = new URL(input);
    calls.push(url.pathname);
    const json = (status: number, body: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    if (url.pathname.endsWith('/oauth/access_token')) {
      // Like Meta (seen on the real account): a missing or different redirect_uri fails with 100 / 36008.
      if (url.searchParams.get('redirect_uri') !== instagramEnv.INSTAGRAM_REDIRECT_URI) {
        return json(400, {
          error: {
            message: 'Error validating verification code',
            type: 'OAuthException',
            code: 100,
            error_subcode: 36008,
          },
        });
      }
      return options.exchangeFails
        ? json(400, {
            error: {
              message: `bad code ${url.searchParams.get('code') ?? ''}`,
              code: 100,
              type: 'OAuthException',
            },
          })
        : json(200, { access_token: ACCESS_TOKEN, token_type: 'bearer' });
    }
    if (url.pathname.endsWith('/me/assigned_instagram_accounts')) {
      return json(200, { data: [{ id: IG_ACCOUNT_ID, username: 'abassoum88888' }] });
    }
    return json(404, { error: { message: 'unexpected', code: 803 } });
  };
  return { fetchImpl, calls };
}

let db: Db;
let orgA: string;
let orgB: string;

beforeAll(async () => {
  db = createDb({ connectionString: inject('databaseUrl') });
  for (const name of ['A', 'B']) {
    const org = await db.createOrganization({ name: `Org ${name}` });
    await db.withTenant(org.id, (tx) =>
      tx.workspace.create({ data: { organizationId: org.id, name: 'Main' } }),
    );
    if (name === 'A') orgA = org.id;
    else orgB = org.id;
  }
});

afterAll(async () => {
  await db.disconnect();
});

async function startApp(graph = fakeGraph(), extraEnv: Record<string, string> = instagramEnv) {
  const logs = createLogCapture();
  const app = await createTestApp({
    env: createTestEnv(extraEnv),
    graphFetch: graph.fetchImpl,
    logStream: logs.stream,
  });
  return { app, logs, graph };
}

async function loginState(app: NestFastifyApplication, organizationId: string): Promise<string> {
  const res = await app.inject({
    url: '/api/v1/integrations/instagram/connect',
    headers: { [DEV_TENANT_HEADER]: organizationId },
  });
  expect(res.statusCode).toBe(200);
  return new URL(res.json<{ loginUrl: string }>().loginUrl).searchParams.get('state') ?? '';
}

const callback = (app: NestFastifyApplication, query: Record<string, string>) =>
  app.inject({
    url: `/api/v1/integrations/instagram/callback?${new URLSearchParams(query).toString()}`,
  });

describe('connecting an Instagram account', () => {
  let ctx: Awaited<ReturnType<typeof startApp>>;

  beforeEach(async () => {
    ctx = await startApp();
  });

  it('the login URL carries the configuration and a state signed for the caller organization', async () => {
    const res = await ctx.app.inject({
      url: '/api/v1/integrations/instagram/connect',
      headers: { [DEV_TENANT_HEADER]: orgA },
    });
    const url = new URL(res.json<{ loginUrl: string }>().loginUrl);

    expect(url.searchParams.get('client_id')).toBe(instagramEnv.META_APP_ID);
    expect(url.searchParams.get('config_id')).toBe(instagramEnv.INSTAGRAM_CONFIG_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(instagramEnv.INSTAGRAM_REDIRECT_URI);
    expect(res.body).not.toContain(APP_SECRET);
    const { Secret } = await import('@app/vault');
    expect(
      verifyOAuthState(new Secret(STATE_SECRET), url.searchParams.get('state') ?? undefined)
        ?.organizationId,
    ).toBe(orgA);
    await ctx.app.close();
  });

  it('stores the account in the organization of the state, with the token sealed (never in clear)', async () => {
    const state = await loginState(ctx.app, orgA);

    const res = await callback(ctx.app, { code: 'one-time-code', state });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://tunnel.example.com/accounts?instagram=connected');
    expect(res.body).not.toContain(ACCESS_TOKEN);

    const listA = await ctx.app.inject({
      url: '/api/v1/social-accounts',
      headers: { [DEV_TENANT_HEADER]: orgA },
    });
    const listB = await ctx.app.inject({
      url: '/api/v1/social-accounts',
      headers: { [DEV_TENANT_HEADER]: orgB },
    });
    expect(listA.json()).toMatchObject({
      items: [
        {
          platform: 'instagram',
          displayName: 'abassoum88888',
          externalAccountId: IG_ACCOUNT_ID,
          connected: true,
        },
      ],
    });
    expect(listB.json()).toEqual({ items: [] });
    expect(listA.body).not.toContain(ACCESS_TOKEN);

    // Sealed in the database; only the worker's master private key opens it.
    const opened = await db.withTenant(orgA, async (tx) => {
      const credential = await tx.oauthCredential.findFirstOrThrow();
      expect(Buffer.from(credential.sealedTokens).includes(Buffer.from(ACCESS_TOKEN))).toBe(false);
      return createVaultOpener({
        masterPrivateKeys: { 'mk-test': master.privateKey },
      }).loadCredential(tx, {
        organizationId: orgA,
        socialAccountId: credential.socialAccountId,
      });
    });
    expect(opened?.tokens.accessToken.reveal()).toBe(ACCESS_TOKEN);
    expect(ctx.logs.raw.join('')).not.toContain(ACCESS_TOKEN);
    await ctx.app.close();
  });

  it.each([
    ['missing', undefined],
    ['forged', 'eyJvIjoiZm9yZ2VkIn0.c2lnbmF0dXJl'],
  ])('a %s state is refused before any call to Meta', async (_, state) => {
    const res = await callback(ctx.app, { code: 'c', ...(state ? { state } : {}) });

    expect(res.headers.location).toBe(
      'https://tunnel.example.com/accounts?instagram=invalid_state',
    );
    expect(ctx.graph.calls).toEqual([]);
    await ctx.app.close();
  });

  it('a state tampered to point at another organization is refused', async () => {
    const state = await loginState(ctx.app, orgA);
    const [payload = '', signature = ''] = state.split('.');
    const forged = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    forged.o = orgB;
    const tampered = `${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${signature}`;

    const res = await callback(ctx.app, { code: 'c', state: tampered });

    expect(res.headers.location).toContain('instagram=invalid_state');
    expect(ctx.graph.calls).toEqual([]);
    await ctx.app.close();
  });

  it('a refusal on Meta’s screen stores nothing and calls nothing', async () => {
    const state = await loginState(ctx.app, orgA);

    const res = await callback(ctx.app, { error: 'access_denied', state });

    expect(res.headers.location).toContain('instagram=cancelled');
    expect(ctx.graph.calls).toEqual([]);
    await ctx.app.close();
  });
});

describe('failures and configuration', () => {
  it('a failed code exchange ends as "failed" without logging the code or the app secret', async () => {
    const ctx = await startApp(fakeGraph({ exchangeFails: true }));
    const state = await loginState(ctx.app, orgA);

    const res = await callback(ctx.app, { code: 'secret-one-time-code', state });

    expect(res.headers.location).toContain('instagram=failed');
    const logs = ctx.logs.raw.join('');
    expect(logs).not.toContain('secret-one-time-code');
    expect(logs).not.toContain(APP_SECRET);
    await ctx.app.close();
  });

  it('without configuration the connect route answers 503', async () => {
    const ctx = await startApp(fakeGraph(), {});
    const res = await ctx.app.inject({
      url: '/api/v1/integrations/instagram/connect',
      headers: { [DEV_TENANT_HEADER]: orgA },
    });
    expect(res.statusCode).toBe(503);
    await ctx.app.close();
  });

  it('connect requires an organization like every non-public route', async () => {
    const ctx = await startApp();
    const res = await ctx.app.inject({ url: '/api/v1/integrations/instagram/connect' });
    expect(res.statusCode).toBe(401);
    await ctx.app.close();
  });

  it('a partial configuration is rejected at startup, and secrets print as [REDACTED]', () => {
    expect(() => createTestEnv({ META_APP_ID: '123' })).toThrow(/META_APP_SECRET/);
    const env = createTestEnv(instagramEnv);
    expect(JSON.stringify(env)).not.toContain(APP_SECRET);
    expect(JSON.stringify(env)).not.toContain(STATE_SECRET);
  });
});
