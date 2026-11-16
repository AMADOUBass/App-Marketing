import { randomUUIDv7 } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDb, type Db, type IdempotentRequest } from '../src/index.js';

let db: Db;
let orgA: string;
let orgB: string;
let workspaceA: string;
let workspaceB: string;

const request = (key: string, overrides: Partial<IdempotentRequest> = {}): IdempotentRequest => ({
  key,
  operation: 'POST /posts',
  requestHash: 'hash-1',
  ttlSeconds: 3600,
  ...overrides,
});

/** The business change: creates a post, so a second execution would be visible as a second row. */
const createPost =
  (organizationId: string, workspaceId: string) =>
  async (tx: Parameters<Parameters<Db['withTenant']>[1]>[0]) => {
    const post = await tx.post.create({ data: { organizationId, workspaceId, body: 'hello' } });
    return { status: 201, body: { id: post.id } };
  };

const countPosts = (organizationId: string) =>
  db.withTenant(organizationId, (tx) => tx.post.count());

beforeAll(async () => {
  db = createDb({ connectionString: inject('appUserUrl') });
  for (const name of ['A', 'B']) {
    const org = await db.createOrganization({ name: `Idem ${name}` });
    const workspace = await db.withTenant(org.id, (tx) =>
      tx.workspace.create({ data: { organizationId: org.id, name: 'Main' } }),
    );
    if (name === 'A') {
      orgA = org.id;
      workspaceA = workspace.id;
    } else {
      orgB = org.id;
      workspaceB = workspace.id;
    }
  }
});

afterAll(async () => {
  await db.disconnect();
});

describe('idempotent create requests', () => {
  it('two organizations using the same key do not see each other (multi-tenant first)', async () => {
    const key = randomUUIDv7();

    const a = await db.idempotent(orgA, request(key), createPost(orgA, workspaceA));
    const b = await db.idempotent(orgB, request(key), createPost(orgB, workspaceB));

    expect(a.outcome).toBe('executed');
    expect(b.outcome).toBe('executed');
    const rowsOfA = await db.withTenant(orgA, (tx) =>
      tx.idempotencyKey.findMany({ where: { key } }),
    );
    expect(rowsOfA.map((row) => row.organizationId)).toEqual([orgA]);
  });

  it('a retry with the same key replays the first answer and changes nothing', async () => {
    const key = randomUUIDv7();
    const before = await countPosts(orgA);

    const first = await db.idempotent(orgA, request(key), createPost(orgA, workspaceA));
    const retry = await db.idempotent(orgA, request(key), createPost(orgA, workspaceA));

    expect(first.outcome).toBe('executed');
    expect(retry).toEqual({
      outcome: 'replayed',
      status: 201,
      body: first.outcome === 'executed' ? first.body : null,
    });
    expect(await countPosts(orgA)).toBe(before + 1);
  });

  it('the same key with another request or another operation is refused', async () => {
    const key = randomUUIDv7();
    await db.idempotent(orgA, request(key), createPost(orgA, workspaceA));

    const otherInput = await db.idempotent(
      orgA,
      request(key, { requestHash: 'hash-2' }),
      createPost(orgA, workspaceA),
    );
    const otherOperation = await db.idempotent(
      orgA,
      request(key, { operation: 'POST /posts/x/schedule' }),
      createPost(orgA, workspaceA),
    );

    expect(otherInput).toEqual({ outcome: 'mismatch' });
    expect(otherOperation).toEqual({ outcome: 'mismatch' });
  });

  it('concurrent requests with the same key run the change once and get the same answer', async () => {
    const key = randomUUIDv7();
    const before = await countPosts(orgA);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        db.idempotent(orgA, request(key), createPost(orgA, workspaceA)),
      ),
    );

    expect(results.filter((r) => r.outcome === 'executed')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'replayed')).toHaveLength(4);
    expect(new Set(results.map((r) => JSON.stringify('body' in r ? r.body : null))).size).toBe(1);
    expect(await countPosts(orgA)).toBe(before + 1);
  });

  it('a failed request stores nothing: the same key can be used again', async () => {
    const key = randomUUIDv7();

    await expect(
      db.idempotent(orgA, request(key), () => Promise.reject(new Error('validation failed'))),
    ).rejects.toThrow('validation failed');
    const again = await db.idempotent(orgA, request(key), createPost(orgA, workspaceA));

    expect(again.outcome).toBe('executed');
  });

  it('an expired key is forgotten and runs again', async () => {
    const key = randomUUIDv7();
    await db.idempotent(orgA, request(key, { ttlSeconds: -1 }), createPost(orgA, workspaceA));

    const later = await db.idempotent(orgA, request(key), createPost(orgA, workspaceA));

    expect(later.outcome).toBe('executed');
  });
});
