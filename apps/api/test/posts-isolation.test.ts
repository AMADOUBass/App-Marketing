import { randomUUIDv7 } from 'node:crypto';
import { createDb, type Db } from '@ponctua/db';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { DEV_TENANT_HEADER } from '../src/common/tenant.js';
import { createTestApp, createTestEnv } from './helpers.js';

interface Tenant {
  orgId: string;
  postIds: string[];
}

let app: NestFastifyApplication;
let db: Db;
let a: Tenant;
let b: Tenant;

async function seedTenant(name: string, posts: number): Promise<Tenant> {
  const org = await db.createOrganization({ name });
  const postIds = await db.withTenant(org.id, async (tx) => {
    const workspace = await tx.workspace.create({
      data: { organizationId: org.id, name: `${name} workspace` },
    });
    const ids: string[] = [];
    for (let i = 0; i < posts; i++) {
      const post = await tx.post.create({
        data: {
          organizationId: org.id,
          workspaceId: workspace.id,
          body: `${name} post ${String(i)}`,
        },
      });
      ids.push(post.id);
    }
    return ids;
  });
  return { orgId: org.id, postIds };
}

const as = (tenant: Tenant) => ({ [DEV_TENANT_HEADER]: tenant.orgId });

function firstPost(tenant: Tenant): string {
  const id = tenant.postIds[0];
  if (!id) throw new Error('fixture has no post');
  return id;
}

beforeAll(async () => {
  db = createDb({ connectionString: inject('databaseUrl') });
  a = await seedTenant('Org A', 3);
  b = await seedTenant('Org B', 1);
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await db.disconnect();
});

describe('organization A cannot read organization B through the API', () => {
  it('gets 404 for a post of B, identical to a post that does not exist', async () => {
    const other = await app.inject({ url: `/api/v1/posts/${firstPost(b)}`, headers: as(a) });
    const missing = await app.inject({ url: `/api/v1/posts/${randomUUIDv7()}`, headers: as(a) });

    expect(other.statusCode).toBe(404);
    expect(other.headers['content-type']).toMatch(/^application\/problem\+json/);
    // Same shape and wording: no way to tell "exists elsewhere" from "does not exist".
    const strip = (body: Record<string, unknown>) => ({ ...body, instance: undefined });
    expect(strip(other.json())).toEqual(strip(missing.json()));
    expect(other.body).not.toContain('Org B');
  });

  it('lists only its own posts', async () => {
    const res = await app.inject({ url: '/api/v1/posts', headers: as(a) });

    expect(res.statusCode).toBe(200);
    const page = res.json<{ items: { id: string }[] }>();
    expect(page.items.map((p) => p.id).sort()).toEqual([...a.postIds].sort());
  });

  it('reads its own post', async () => {
    const res = await app.inject({ url: `/api/v1/posts/${firstPost(a)}`, headers: as(a) });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: firstPost(a), body: 'Org A post 0' });
  });
});

describe('organization A cannot write organization B through the API', () => {
  it('gets 404 when updating a post of B, and the post is unchanged', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/posts/${firstPost(b)}`,
      headers: as(a),
      payload: { body: 'hacked' },
    });

    expect(res.statusCode).toBe(404);
    const stored = await db.withTenant(b.orgId, (tx) =>
      tx.post.findUnique({ where: { id: firstPost(b) } }),
    );
    expect(stored?.body).toBe('Org B post 0');
  });

  it('updates its own post', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/posts/${firstPost(a)}`,
      headers: as(a),
      payload: { body: '  edited  ' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: firstPost(a), body: 'edited' });
  });

  it('cannot move a post to another organization through the body', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/posts/${firstPost(a)}`,
      headers: as(a),
      payload: { body: 'x', organizationId: b.orgId },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('organization context', () => {
  it('returns 401 without an organization', async () => {
    const res = await app.inject({ url: '/api/v1/posts' });

    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  });

  it.each(['not-a-uuid', "x' OR '1'='1", ''])('returns 401 for organization %j', async (orgId) => {
    const res = await app.inject({ url: '/api/v1/posts', headers: { [DEV_TENANT_HEADER]: orgId } });

    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when the dev header is disabled, even with a valid organization', async () => {
    const locked = await createTestApp({ env: createTestEnv({ DEV_TENANT_HEADER: 'false' }) });
    try {
      const res = await locked.inject({ url: '/api/v1/posts', headers: as(a) });
      expect(res.statusCode).toBe(401);
    } finally {
      await locked.close();
    }
  });

  it('returns 400 problem+json for an invalid post id', async () => {
    const res = await app.inject({ url: '/api/v1/posts/not-a-uuid', headers: as(a) });

    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  });
});

describe('cursor pagination', () => {
  it('walks every post of the organization, newest first, without duplicates', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `?limit=2&cursor=${cursor}` : '?limit=2';
      const res = await app.inject({ url: `/api/v1/posts${query}`, headers: as(a) });
      const page = res.json<{ items: { id: string }[]; nextCursor: string | null }>();
      seen.push(...page.items.map((p) => p.id));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toEqual([...a.postIds].reverse());
  });
});
