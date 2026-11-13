// Connecting a client's Instagram professional account (Instagram API with Unified Login, ADR 007).
// Server side only: the app secret and the tokens never reach the browser (rule 3).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Secret } from '@app/vault';
import { z } from 'zod';
import { instagramCapabilities } from '../capabilities/instagram.js';
import type { GraphRequestFn } from './graph-client.js';

export interface LoginUrlInput {
  /** Meta app id (not secret). */
  appId: string;
  /** Configuration created in the App Dashboard (API setup with Unified login). */
  configId: string;
  /** HTTPS URL registered in the App Dashboard. */
  redirectUri: string;
  /** Anti-CSRF value from createOAuthState(), bound to the user's session. */
  state: string;
  /** Always offer both Facebook and Instagram login options (documented: prompt=login). */
  forceLoginChoice?: boolean;
}

/**
 * Facebook Login for Business dialog URL. TO CONFIRM on the real account (9c): the Unified Login
 * authentication page only says the URL carries the config_id; the other parameters follow the standard
 * Facebook Login for Business manual flow.
 */
export function buildLoginUrl(input: LoginUrlInput): string {
  const redirect = new URL(input.redirectUri);
  if (redirect.protocol !== 'https:') throw new Error('redirectUri must use HTTPS');

  const url = new URL(
    `${instagramCapabilities.loginDialogHost.value}/${instagramCapabilities.graphApiVersion.value}/dialog/oauth`,
  );
  url.searchParams.set('client_id', input.appId);
  url.searchParams.set('config_id', input.configId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('override_default_response_type', 'true');
  url.searchParams.set('state', input.state);
  if (input.forceLoginChoice) url.searchParams.set('prompt', 'login');
  return url.toString();
}

/** Random, unguessable state for the OAuth round trip. */
export function createOAuthState(): string {
  return randomBytes(32).toString('base64url');
}

/** Constant-time comparison of the state received on the callback with the one stored in the session. */
export function verifyOAuthState(expected: string, received: string | null | undefined): boolean {
  if (!received) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().optional(),
});

export interface ExchangedToken {
  accessToken: Secret;
  /** null when the platform reports no expiry (system-user tokens: "Expiration: Never"). */
  expiresAt: Date | null;
}

/**
 * GET /oauth/access_token with the Meta app id, app secret, code and the SAME redirect_uri as the login
 * dialog. The Unified Login page lists only the first three; the Facebook Login manual-flow reference
 * requires redirect_uri, and the real account confirmed it (without it: code 100 / subcode 36008).
 * https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow
 */
export async function exchangeCodeForToken(
  graph: GraphRequestFn,
  input: { appId: string; appSecret: Secret; code: string; redirectUri: string; now?: Date },
): Promise<ExchangedToken> {
  const response = await graph(
    {
      method: 'GET',
      path: '/oauth/access_token',
      params: {
        client_id: input.appId,
        redirect_uri: input.redirectUri,
        client_secret: input.appSecret.reveal(),
        code: input.code,
      },
    },
    tokenResponseSchema,
  );
  const now = input.now ?? new Date();
  return {
    accessToken: new Secret(response.access_token),
    expiresAt: response.expires_in ? new Date(now.getTime() + response.expires_in * 1000) : null,
  };
}

const assignedAccountsSchema = z.object({
  data: z.array(z.looseObject({ id: z.string().min(1), username: z.string().optional() })),
});

export interface ConnectedInstagramAccount {
  id: string;
  username: string | null;
}

/**
 * Documented: /me/assigned_instagram_accounts lists the accounts the client shared ("Don't use /me to find
 * the account"). The returned fields are not documented: only `id` is relied on (TO CONFIRM in 9c).
 */
export async function listAssignedInstagramAccounts(
  graph: GraphRequestFn,
  accessToken: Secret,
): Promise<ConnectedInstagramAccount[]> {
  const response = await graph(
    { method: 'GET', path: '/me/assigned_instagram_accounts', accessToken },
    assignedAccountsSchema,
  );
  return response.data.map((account) => ({ id: account.id, username: account.username ?? null }));
}
