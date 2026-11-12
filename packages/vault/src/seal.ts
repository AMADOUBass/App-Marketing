// API side (ADR 006): stores OAuth tokens sealed with the organization PUBLIC key. Holds no private key,
// so nothing imported from here can ever read a stored token back.
import type { TenantTx } from '@app/db';
import {
  encodeTokens,
  type OauthTokens,
  orgKeyAssociatedData,
  tokensAssociatedData,
} from './credentials.js';
import { fromBase64Url, generateRawKeyPair, seal } from './sealed-box.js';

export interface VaultSealerConfig {
  /** Id of the current master key pair (stored next to each sealed organization key, for rotation). */
  masterKeyId: string;
  /** Current master PUBLIC key, base64url (from `pnpm vault:keygen`). */
  masterPublicKey: string;
}

export interface StoreCredentialInput {
  organizationId: string;
  socialAccountId: string;
  tokens: OauthTokens;
  scopes: string[];
  /** Expiry reported by the platform, never a hardcoded duration. */
  expiresAt: Date | null;
}

/** Metadata only: callers never get sealed or clear tokens back from the store. */
export interface StoredCredential {
  id: string;
  socialAccountId: string;
  scopes: string[];
  expiresAt: Date | null;
}

export interface VaultSealer {
  /** Seals and upserts the tokens of a social account (one credential per account). Run inside withTenant. */
  storeCredential(tx: TenantTx, input: StoreCredentialInput): Promise<StoredCredential>;
}

export function createVaultSealer(config: VaultSealerConfig): VaultSealer {
  const masterPublicKey = fromBase64Url(config.masterPublicKey, 'masterPublicKey');

  /** The organization key pair is created on first use; its private half is sealed for the master key. */
  async function organizationKey(tx: TenantTx, organizationId: string) {
    const existing = await tx.organizationKey.findUnique({ where: { organizationId } });
    if (existing) return existing;

    const pair = generateRawKeyPair();
    // ON CONFLICT DO NOTHING: two concurrent first uses keep a single key without aborting the transaction.
    await tx.organizationKey.createMany({
      data: {
        organizationId,
        publicKey: pair.publicKey,
        sealedPrivateKey: seal(
          masterPublicKey,
          pair.privateKey,
          orgKeyAssociatedData(organizationId),
          'org-private-key',
        ),
        masterKeyId: config.masterKeyId,
      },
      skipDuplicates: true,
    });
    pair.privateKey.fill(0);
    return tx.organizationKey.findUniqueOrThrow({ where: { organizationId } });
  }

  return {
    async storeCredential(tx, input) {
      const key = await organizationKey(tx, input.organizationId);
      const sealedTokens = seal(
        key.publicKey,
        encodeTokens(input.tokens),
        tokensAssociatedData(input.organizationId, input.socialAccountId),
        'oauth-tokens',
      );
      const fields = {
        organizationKeyId: key.id,
        sealedTokens,
        scopes: input.scopes,
        expiresAt: input.expiresAt,
      };
      return tx.oauthCredential.upsert({
        where: { socialAccountId: input.socialAccountId },
        create: {
          organizationId: input.organizationId,
          socialAccountId: input.socialAccountId,
          ...fields,
        },
        update: fields,
        select: { id: true, socialAccountId: true, scopes: true, expiresAt: true },
      });
    },
  };
}
