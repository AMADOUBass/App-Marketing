import { randomUUIDv7 } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDb, type Db, InvalidOrganizationIdError } from '../src/index.js';
import { createTestUser } from './users.js';

interface TenantFixture {
  orgId: string;
  workspaceId: string;
  postId: string;
  membershipId: string;
}

let db: Db;
let a: TenantFixture;
let b: TenantFixture;

async function seedTenant(name: string): Promise<TenantFixture> {
  const org = await db.createOrganization({ name });
  const userId = await createTestUser();
  return db.withTenant(org.id, async (tx) => {
    const workspace = await tx.workspace.create({
      data: { organizationId: org.id, name: `${name} workspace` },
    });
    const membership = await tx.membership.create({
      data: { organizationId: org.id, userId, role: 'owner' },
    });
    const post = await tx.post.create({
      data: { organizationId: org.id, workspaceId: workspace.id, body: `${name} post` },
    });
    return {
      orgId: org.id,
      workspaceId: workspace.id,
      postId: post.id,
      membershipId: membership.id,
    };
  });
}

beforeAll(async () => {
  db = createDb({ connectionString: inject('appUserUrl') });
  a = await seedTenant('Org A');
  b = await seedTenant('Org B');
});

afterAll(async () => {
  await db.disconnect();
});

describe('organization A cannot read organization B', () => {
  it('sees only its own rows in every table', async () => {
    const rows = await db.withTenant(a.orgId, async (tx) => ({
      organizations: await tx.organization.findMany(),
      workspaces: await tx.workspace.findMany(),
      memberships: await tx.membership.findMany(),
      posts: await tx.post.findMany(),
    }));

    expect(rows.organizations.map((o) => o.id)).toEqual([a.orgId]);
    expect(rows.workspaces.map((w) => w.id)).toEqual([a.workspaceId]);
    expect(rows.memberships.map((m) => m.id)).toEqual([a.membershipId]);
    expect(rows.posts.map((p) => p.id)).toEqual([a.postId]);
  });

  it('gets null when asking for a B row by id', async () => {
    const found = await db.withTenant(a.orgId, async (tx) => ({
      organization: await tx.organization.findUnique({ where: { id: b.orgId } }),
      workspace: await tx.workspace.findUnique({ where: { id: b.workspaceId } }),
      post: await tx.post.findUnique({ where: { id: b.postId } }),
    }));

    expect(found).toEqual({ organization: null, workspace: null, post: null });
  });
});

describe('organization A cannot write organization B', () => {
  it('updates and deletes 0 rows of B', async () => {
    const result = await db.withTenant(a.orgId, async (tx) => ({
      updated: await tx.post.updateMany({ where: { id: b.postId }, data: { body: 'hacked' } }),
      deleted: await tx.workspace.deleteMany({ where: { id: b.workspaceId } }),
    }));

    expect(result.updated.count).toBe(0);
    expect(result.deleted.count).toBe(0);

    const bPost = await db.withTenant(b.orgId, (tx) =>
      tx.post.findUnique({ where: { id: b.postId } }),
    );
    expect(bPost?.body).toBe('Org B post');
  });

  it('cannot insert a row tagged with B organization_id', async () => {
    await expect(
      db.withTenant(a.orgId, (tx) =>
        tx.workspace.create({ data: { organizationId: b.orgId, name: 'intruder' } }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('cannot create another organization', async () => {
    await expect(
      db.withTenant(a.orgId, (tx) =>
        tx.organization.create({ data: { id: randomUUIDv7(), name: 'rogue' } }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('cannot move its own row to organization B', async () => {
    await expect(
      db.withTenant(a.orgId, (tx) =>
        tx.membership.update({ where: { id: a.membershipId }, data: { organizationId: b.orgId } }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('cannot attach a post to a workspace of B (composite foreign key)', async () => {
    await expect(
      db.withTenant(a.orgId, (tx) =>
        tx.post.create({
          data: { organizationId: a.orgId, workspaceId: b.workspaceId, body: 'cross-tenant' },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
  });
});

describe('tenant context', () => {
  it('fails closed: a query without withTenant errors instead of returning rows', async () => {
    const client = new pg.Client({ connectionString: inject('appUserUrl') });
    await client.connect();
    try {
      await expect(client.query('SELECT * FROM posts')).rejects.toThrow(/app\.org_id/);
    } finally {
      await client.end();
    }
  });

  it('is transaction-local: it does not survive on a reused connection', async () => {
    const pool = new pg.Pool({ connectionString: inject('appUserUrl'), max: 1 });
    try {
      await pool.query('BEGIN');
      await pool.query("SELECT set_config('app.org_id', $1, true)", [a.orgId]);
      await pool.query('COMMIT');

      const { rows } = await pool.query<{ org: string | null }>(
        "SELECT current_setting('app.org_id', true) AS org",
      );
      expect(rows[0]?.org ?? '').toBe('');
      // The reset value is '' which is not a valid uuid: still fails closed.
      await expect(pool.query('SELECT * FROM posts')).rejects.toThrow(/uuid/);
    } finally {
      await pool.end();
    }
  });

  it('switches cleanly between organizations on a single pooled connection', async () => {
    const singleConnectionDb = createDb({
      connectionString: inject('appUserUrl'),
      maxConnections: 1,
    });
    try {
      const aPosts = await singleConnectionDb.withTenant(a.orgId, (tx) => tx.post.findMany());
      const bPosts = await singleConnectionDb.withTenant(b.orgId, (tx) => tx.post.findMany());

      expect(aPosts.map((p) => p.id)).toEqual([a.postId]);
      expect(bPosts.map((p) => p.id)).toEqual([b.postId]);
    } finally {
      await singleConnectionDb.disconnect();
    }
  });

  it.each(['', 'not-a-uuid', "x' OR '1'='1"])('rejects invalid organization id %j', async (id) => {
    await expect(db.withTenant(id, (tx) => tx.post.findMany())).rejects.toThrow(
      InvalidOrganizationIdError,
    );
  });
});
