import { randomUUIDv7 } from 'node:crypto';
import { createDb, type Db } from '@ponctua/db';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { Secret, VaultError } from '../src/index.js';
import { createVaultOpener, parseMasterPrivateKeys } from '../src/open.js';
import { createVaultSealer } from '../src/seal.js';
import { generateRawKeyPair, toBase64Url } from '../src/sealed-box.js';

function masterKey(id: string) {
  const pair = generateRawKeyPair();
  return {
    id,
    publicKey: toBase64Url(pair.publicKey),
    privateKey: toBase64Url(pair.privateKey),
  };
}

const master = masterKey('mk-current');
const sealer = createVaultSealer({ masterKeyId: master.id, masterPublicKey: master.publicKey });
const opener = createVaultOpener({ masterPrivateKeys: { [master.id]: master.privateKey } });

let db: Db;

interface Account {
  orgId: string;
  socialAccountId: string;
}

async function seedAccount(orgId?: string): Promise<Account> {
  const id = orgId ?? (await db.createOrganization({ name: 'Org' })).id;
  const socialAccountId = await db.withTenant(id, async (tx) => {
    const workspace =
      (await tx.workspace.findFirst()) ??
      (await tx.workspace.create({ data: { organizationId: id, name: 'Main' } }));
    const account = await tx.socialAccount.create({
      data: {
        organizationId: id,
        workspaceId: workspace.id,
        platform: 'instagram',
        externalAccountId: randomUUIDv7(),
        displayName: 'IG',
      },
    });
    return account.id;
  });
  return { orgId: id, socialAccountId };
}

const tokens = (access: string) => ({
  accessToken: new Secret(access),
  refreshToken: null,
});

const store = (account: Account, access: string, s = sealer) =>
  db.withTenant(account.orgId, (tx) =>
    s.storeCredential(tx, {
      organizationId: account.orgId,
      socialAccountId: account.socialAccountId,
      tokens: tokens(access),
      scopes: ['instagram_business_basic', 'instagram_business_content_publish'],
      expiresAt: new Date('2027-01-10T00:00:00Z'),
    }),
  );

const load = (account: Account, o = opener) =>
  db.withTenant(account.orgId, (tx) =>
    o.loadCredential(tx, {
      organizationId: account.orgId,
      socialAccountId: account.socialAccountId,
    }),
  );

beforeAll(() => {
  db = createDb({ connectionString: inject('appUserUrl') });
});

afterAll(async () => {
  await db.disconnect();
});

describe('tenant isolation of the vault', () => {
  it('organization B cannot read or open the tokens of organization A', async () => {
    const a = await seedAccount();
    const b = await seedAccount();
    await store(a, 'token-of-A');

    const seenByB = await db.withTenant(b.orgId, async (tx) => ({
      credentials: await tx.oauthCredential.findMany(),
      keys: await tx.organizationKey.findMany(),
      opened: await opener.loadCredential(tx, {
        organizationId: b.orgId,
        socialAccountId: a.socialAccountId,
      }),
    }));

    expect(seenByB).toEqual({ credentials: [], keys: [], opened: null });
  });

  it("a sealed blob of A copied into B's credential does not open", async () => {
    const a = await seedAccount();
    const b = await seedAccount();
    await store(a, 'token-of-A');
    await store(b, 'token-of-B');
    const blobOfA = await db.withTenant(a.orgId, (tx) =>
      tx.oauthCredential.findUniqueOrThrow({ where: { socialAccountId: a.socialAccountId } }),
    );

    await db.withTenant(b.orgId, (tx) =>
      tx.oauthCredential.update({
        where: { socialAccountId: b.socialAccountId },
        data: { sealedTokens: blobOfA.sealedTokens },
      }),
    );

    await expect(load(b)).rejects.toThrow(VaultError);
  });
});

describe('storing and reading tokens', () => {
  it('round-trips through the database; the store only returns metadata', async () => {
    const account = await seedAccount();

    const stored = await store(account, 'IGQVJ-round-trip');
    const opened = await load(account);

    expect(Object.keys(stored).sort()).toEqual(['expiresAt', 'id', 'scopes', 'socialAccountId']);
    expect(opened?.tokens.accessToken.reveal()).toBe('IGQVJ-round-trip');
    expect(opened?.tokens.refreshToken).toBeNull();
    expect(opened?.scopes).toContain('instagram_business_content_publish');
  });

  it('storing again replaces the tokens (one credential per account, one key per organization)', async () => {
    const account = await seedAccount();
    await store(account, 'first');
    await store(account, 'second');

    const counts = await db.withTenant(account.orgId, async (tx) => ({
      credentials: await tx.oauthCredential.count(),
      keys: await tx.organizationKey.count(),
    }));
    expect(counts).toEqual({ credentials: 1, keys: 1 });
    expect((await load(account))?.tokens.accessToken.reveal()).toBe('second');
  });

  it('the database never holds the token or the organization private key in clear', async () => {
    const account = await seedAccount();
    const token = `IGQVJ-plaintext-probe-${randomUUIDv7()}`;
    await store(account, token);

    const client = new pg.Client({ connectionString: inject('migratorUrl') });
    await client.connect();
    try {
      const { rows } = await client.query<{ dump: string }>(
        `SELECT encode(convert_to(row_to_json(c)::text, 'UTF8'), 'escape') AS dump
         FROM oauth_credentials c WHERE social_account_id = $1
         UNION ALL
         SELECT row_to_json(k)::text FROM organization_keys k WHERE organization_id = $2`,
        [account.socialAccountId, account.orgId],
      );
      const dump = rows.map((r) => r.dump).join('\n');
      expect(dump.length).toBeGreaterThan(0);
      for (const form of [
        token,
        Buffer.from(token).toString('hex'),
        Buffer.from(token).toString('base64'),
      ]) {
        expect(dump).not.toContain(form);
      }
    } finally {
      await client.end();
    }
  });

  it('a blob moved to another account of the same organization does not open', async () => {
    const first = await seedAccount();
    const second = await seedAccount(first.orgId);
    await store(first, 'token-1');
    await store(second, 'token-2');

    await db.withTenant(first.orgId, async (tx) => {
      const blob = await tx.oauthCredential.findUniqueOrThrow({
        where: { socialAccountId: first.socialAccountId },
      });
      await tx.oauthCredential.update({
        where: { socialAccountId: second.socialAccountId },
        data: { sealedTokens: blob.sealedTokens },
      });
    });

    await expect(load(second)).rejects.toThrow(VaultError);
  });
});

describe('master key rotation', () => {
  it('keeps old organizations readable while their key was sealed with a retired master key', async () => {
    const retired = masterKey('mk-2025');
    const oldSealer = createVaultSealer({
      masterKeyId: retired.id,
      masterPublicKey: retired.publicKey,
    });
    const account = await seedAccount();
    await store(account, 'sealed-under-retired-key', oldSealer);

    const bothKeys = createVaultOpener({
      masterPrivateKeys: parseMasterPrivateKeys(
        `${master.id}:${master.privateKey},${retired.id}:${retired.privateKey}`,
      ),
    });

    expect((await load(account, bothKeys))?.tokens.accessToken.reveal()).toBe(
      'sealed-under-retired-key',
    );
    await expect(load(account, opener)).rejects.toThrow(/unknown master key id/);
  });
});

describe('crypto-shredding', () => {
  it("deleting an organization's key makes its tokens unrecoverable", async () => {
    const account = await seedAccount();
    await store(account, 'to-be-shredded');

    await db.withTenant(account.orgId, (tx) => tx.organizationKey.deleteMany());

    expect(await load(account)).toBeNull();
    const left = await db.withTenant(account.orgId, (tx) => tx.oauthCredential.count());
    expect(left).toBe(0);
  });
});

describe('configuration', () => {
  it('rejects malformed keys without echoing them', () => {
    expect(() => createVaultSealer({ masterKeyId: 'x', masterPublicKey: 'not-a-key' })).toThrow(
      /base64url-encoded 32-byte key/,
    );
    expect(() => createVaultOpener({ masterPrivateKeys: {} })).toThrow(VaultError);
    expect(() => parseMasterPrivateKeys('missing-separator')).toThrow(VaultError);
  });
});
