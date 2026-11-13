import { Secret } from '@app/vault';
import { describe, expect, it } from 'vitest';
import {
  buildLoginUrl,
  createGraphClient,
  createOAuthState,
  exchangeCodeForToken,
  GraphApiError,
  listAssignedInstagramAccounts,
  verifyOAuthState,
} from '../src/index.js';
import { createFakeGraph } from './fake-graph.js';
import { errors, IG_USER_ID } from './fixtures/instagram.js';

const APP_SECRET = 'meta-app-secret-never-logged';

describe('login URL', () => {
  it('carries the configuration, the redirect URL and an anti-CSRF state', () => {
    const url = new URL(
      buildLoginUrl({
        appId: '1604528421424442',
        configId: '987654321',
        redirectUri: 'https://app.example.com/api/v1/integrations/instagram/callback',
        state: 'state-123',
        forceLoginChoice: true,
      }),
    );

    expect(url.origin + url.pathname).toBe('https://www.facebook.com/v27.0/dialog/oauth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: '1604528421424442',
      config_id: '987654321',
      redirect_uri: 'https://app.example.com/api/v1/integrations/instagram/callback',
      response_type: 'code',
      override_default_response_type: 'true',
      state: 'state-123',
      prompt: 'login',
    });
  });

  it('refuses a non-HTTPS redirect URL (documented requirement)', () => {
    expect(() =>
      buildLoginUrl({ appId: '1', configId: '2', redirectUri: 'http://localhost/cb', state: 's' }),
    ).toThrow(/HTTPS/);
  });
});

describe('OAuth state', () => {
  it('is random and verified exactly', () => {
    const state = createOAuthState();
    expect(state).not.toBe(createOAuthState());
    expect(state.length).toBeGreaterThanOrEqual(43);
    expect(verifyOAuthState(state, state)).toBe(true);
    expect(verifyOAuthState(state, `${state}x`)).toBe(false);
    expect(verifyOAuthState(state, 'other')).toBe(false);
    expect(verifyOAuthState(state, null)).toBe(false);
  });
});

describe('code exchange', () => {
  it('calls GET /oauth/access_token server side and returns the token as a Secret', async () => {
    const graph = createFakeGraph().on('GET', /\/oauth\/access_token$/, {
      json: { access_token: 'EAAG-new-token', token_type: 'bearer' },
    });

    const token = await exchangeCodeForToken(createGraphClient({ fetch: graph.fetch }), {
      appId: '1604528421424442',
      appSecret: new Secret(APP_SECRET),
      code: 'auth-code',
      redirectUri: 'https://app.example.com/api/v1/integrations/instagram/callback',
    });

    const params = graph.requests[0]?.url.searchParams;
    expect(params?.get('client_id')).toBe('1604528421424442');
    expect(params?.get('client_secret')).toBe(APP_SECRET);
    expect(params?.get('code')).toBe('auth-code');
    // Required by Meta (manual flow) and identical to the dialog's: else 100 / 36008.
    expect(params?.get('redirect_uri')).toBe(
      'https://app.example.com/api/v1/integrations/instagram/callback',
    );
    expect(token.accessToken).toBeInstanceOf(Secret);
    expect(token.accessToken.reveal()).toBe('EAAG-new-token');
    expect(JSON.stringify(token)).not.toContain('EAAG-new-token');
    expect(token.expiresAt).toBeNull(); // system-user tokens: "Expiration: Never"
  });

  it('an exchange failure never echoes the app secret', async () => {
    const graph = createFakeGraph().on('GET', /\/oauth\/access_token$/, {
      status: 400,
      json: errors.tokenExpired,
    });

    const failure = await exchangeCodeForToken(createGraphClient({ fetch: graph.fetch }), {
      appId: '1',
      appSecret: new Secret(APP_SECRET),
      code: 'bad',
      redirectUri: 'https://app.example.com/cb',
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GraphApiError);
    expect(`${String(failure)} ${JSON.stringify(failure)}`).not.toContain(APP_SECRET);
  });

  it('a network failure never echoes the URL (which carries the secret)', async () => {
    const graph = createFakeGraph().on('GET', /\/oauth\/access_token$/, { networkError: true });

    const failure = await exchangeCodeForToken(createGraphClient({ fetch: graph.fetch }), {
      appId: '1',
      appSecret: new Secret(APP_SECRET),
      code: 'c',
      redirectUri: 'https://app.example.com/cb',
    }).then(
      () => new Error('expected the exchange to fail'),
      (error: unknown) => error as Error,
    );

    expect(
      `${failure.message} ${failure.stack ?? ''} ${JSON.stringify(failure.cause)}`,
    ).not.toContain(APP_SECRET);
  });
});

describe('connected accounts', () => {
  it('lists the Instagram accounts shared by the client (not /me)', async () => {
    const graph = createFakeGraph().on('GET', /\/me\/assigned_instagram_accounts$/, {
      json: { data: [{ id: IG_USER_ID, username: 'abassoum88888' }] },
    });

    const accounts = await listAssignedInstagramAccounts(
      createGraphClient({ fetch: graph.fetch }),
      new Secret('EAAG-token'),
    );

    expect(accounts).toEqual([{ id: IG_USER_ID, username: 'abassoum88888' }]);
    expect(graph.requests[0]?.headers.authorization).toBe('Bearer EAAG-token');
  });
});
