import { Secret } from './secret.js';
import { VaultError } from './sealed-box.js';

/** Tokens returned by a platform's OAuth flow. Values stay wrapped in Secret everywhere. */
export interface OauthTokens {
  accessToken: Secret;
  refreshToken: Secret | null;
}

interface TokensJson {
  accessToken: string;
  refreshToken: string | null;
}

/** Associated data: a sealed blob only opens for this exact organization and social account. */
export const tokensAssociatedData = (organizationId: string, socialAccountId: string): string =>
  `oauth-tokens:${organizationId}:${socialAccountId}`;

export const orgKeyAssociatedData = (organizationId: string): string =>
  `org-private-key:${organizationId}`;

export function encodeTokens(tokens: OauthTokens): Buffer {
  const json: TokensJson = {
    accessToken: tokens.accessToken.reveal(),
    refreshToken: tokens.refreshToken?.reveal() ?? null,
  };
  return Buffer.from(JSON.stringify(json), 'utf8');
}

export function decodeTokens(bytes: Buffer): OauthTokens {
  const json = JSON.parse(bytes.toString('utf8')) as Partial<TokensJson>;
  if (typeof json.accessToken !== 'string') throw new VaultError('malformed sealed tokens');
  return {
    accessToken: new Secret(json.accessToken),
    refreshToken: typeof json.refreshToken === 'string' ? new Secret(json.refreshToken) : null,
  };
}
