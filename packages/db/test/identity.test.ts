import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDb, type Db } from '../src/index.js';
import { createTestUser } from './users.js';

let db: Db;

async function query(url: string, sql: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

beforeAll(() => {
  db = createDb({ connectionString: inject('appUserUrl') });
});

afterAll(async () => {
  await db.disconnect();
});

describe('identity tables are walled off (ADR 008)', () => {
  it('app_user (business code, worker) cannot read the auth schema at all', async () => {
    await expect(query(inject('appUserUrl'), 'SELECT * FROM auth.users')).rejects.toThrow(
      /permission denied for schema auth/,
    );
    await expect(query(inject('appUserUrl'), 'SELECT * FROM auth.sessions')).rejects.toThrow(
      /permission denied/,
    );
  });

  it('app_auth (Better Auth) can manage identities but cannot reach business tables', async () => {
    const userId = await createTestUser();
    const { rows } = await query(inject('authUrl'), 'SELECT id FROM auth.users WHERE id = $1', [
      userId,
    ]);
    expect(rows).toEqual([{ id: userId }]);

    for (const table of ['posts', 'memberships', 'oauth_credentials', 'organization_keys']) {
      await expect(query(inject('authUrl'), `SELECT * FROM public.${table}`)).rejects.toThrow(
        /permission denied/,
      );
    }
  });
});

describe('organization onboarding', () => {
  it('creates the organization, the owner membership and the first workspace together', async () => {
    const owner = await createTestUser();

    const org = await db.createOrganizationWithOwner({
      name: 'Agence Lumière',
      ownerUserId: owner,
      workspaceName: 'Principal',
    });

    const content = await db.withTenant(org.id, async (tx) => ({
      memberships: await tx.membership.findMany({ select: { userId: true, role: true } }),
      workspaces: await tx.workspace.findMany({ select: { name: true } }),
    }));
    expect(content).toEqual({
      memberships: [{ userId: owner, role: 'owner' }],
      workspaces: [{ name: 'Principal' }],
    });
  });

  it('refuses an owner that is not a real user (foreign key to auth.users)', async () => {
    await expect(
      db.createOrganizationWithOwner({
        name: 'Ghost',
        ownerUserId: '0195f000-0000-7000-8000-0000000000ff',
        workspaceName: 'Principal',
      }),
    ).rejects.toThrow(/foreign key/i);
  });
});

describe('directory: organizations of one user (the only cross-organization membership read)', () => {
  it('lists exactly the organizations the user belongs to, with the role, and nothing else', async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();
    const a = await db.createOrganizationWithOwner({
      name: 'A Org',
      ownerUserId: alice,
      workspaceName: 'W',
    });
    const b = await db.createOrganizationWithOwner({
      name: 'B Org',
      ownerUserId: bob,
      workspaceName: 'W',
    });
    await db.withTenant(b.id, (tx) =>
      tx.membership.create({ data: { organizationId: b.id, userId: alice, role: 'member' } }),
    );
    await db.createOrganizationWithOwner({ name: 'C Org', ownerUserId: bob, workspaceName: 'W' });

    expect(await db.directory.listOrganizations(alice)).toEqual([
      { organizationId: a.id, name: 'A Org', role: 'owner' },
      { organizationId: b.id, name: 'B Org', role: 'member' },
    ]);
    expect(await db.directory.listOrganizations(await createTestUser())).toEqual([]);
    expect(await db.directory.listOrganizations('not-a-uuid')).toEqual([]);
  });

  it('does not open memberships to app_user without tenant context', async () => {
    await expect(query(inject('appUserUrl'), 'SELECT * FROM memberships')).rejects.toThrow(
      /app\.org_id/,
    );
  });

  it('deleting a user removes their memberships (no orphan access)', async () => {
    const carol = await createTestUser();
    const org = await db.createOrganizationWithOwner({
      name: 'D Org',
      ownerUserId: carol,
      workspaceName: 'W',
    });

    await query(inject('authUrl'), 'DELETE FROM auth.users WHERE id = $1', [carol]);

    expect(await db.directory.listOrganizations(carol)).toEqual([]);
    expect(await db.withTenant(org.id, (tx) => tx.membership.count())).toBe(0);
  });
});
