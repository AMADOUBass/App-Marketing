// Worker side only (ADR 006): needs the master PRIVATE keys. The API must never import this module
// (enforced by an ESLint rule in apps/api).
import type { TenantTx } from '@ponctua/db';
import {
  decodeTokens,
  type OauthTokens,
  orgKeyAssociatedData,
  tokensAssociatedData,
} from './credentials.js';
import { fromBase64Url, open, VaultError } from './sealed-box.js';

export interface VaultOpenerConfig {
  /**
   * Master private keys by id, base64url. Keep retired keys here until every organization key sealed
   * with them has been re-sealed with the current one (rotation).
   */
  masterPrivateKeys: Record<string, string>;
}

export interface OpenedCredential {
  tokens: OauthTokens;
  scopes: string[];
  expiresAt: Date | null;
}

export interface VaultOpener {
  /** Reads and opens the tokens of a social account, or null if none. Run inside withTenant. */
  loadCredential(
    tx: TenantTx,
    ref: { organizationId: string; socialAccountId: string },
  ): Promise<OpenedCredential | null>;
}

/** Parses "id1:base64url,id2:base64url" (env format of VAULT_MASTER_PRIVATE_KEYS). */
export function parseMasterPrivateKeys(value: string): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const entry of value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)) {
    const separator = entry.indexOf(':');
    if (separator <= 0) throw new VaultError('master private keys must be "id:key" pairs');
    keys[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return keys;
}

export function createVaultOpener(config: VaultOpenerConfig): VaultOpener {
  const masterKeys = new Map(
    Object.entries(config.masterPrivateKeys).map(([id, key]) => [
      id,
      fromBase64Url(key, `master private key "${id}"`),
    ]),
  );
  if (masterKeys.size === 0) throw new VaultError('at least one master private key is required');

  return {
    async loadCredential(tx, { organizationId, socialAccountId }) {
      const credential = await tx.oauthCredential.findUnique({
        where: { socialAccountId },
        include: { organizationKey: true },
      });
      if (!credential) return null;

      const { organizationKey } = credential;
      const masterKey = masterKeys.get(organizationKey.masterKeyId);
      if (!masterKey) throw new VaultError('organization key sealed with an unknown master key id');

      const orgPrivateKey = open(
        masterKey,
        organizationKey.sealedPrivateKey,
        orgKeyAssociatedData(organizationId),
        'org-private-key',
      );
      try {
        const tokens = decodeTokens(
          open(
            orgPrivateKey,
            credential.sealedTokens,
            tokensAssociatedData(organizationId, socialAccountId),
            'oauth-tokens',
          ),
        );
        return { tokens, scopes: credential.scopes, expiresAt: credential.expiresAt };
      } finally {
        orgPrivateKey.fill(0);
      }
    },
  };
}
