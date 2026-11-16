import { randomBytes, randomUUID } from 'node:crypto';
import { createDb, type Db, type Platform, type PublicationState } from '@ponctua/db';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { IDEMPOTENT_REPLAYED_HEADER } from '../src/common/idempotency.js';
import {
  addMember,
  asMember,
  createTestApp,
  signUpUser,
  type TestUser,
  WEB_ORIGIN,
} from './helpers.js';

interface Tenant {
  orgId: string;
  workspaceId: string;
  otherWorkspaceId: string;
  member: TestUser;
  /** Connected Instagram account of the main workspace. */
  instagramId: string;
}

let app: NestFastifyApplication;
let db: Db;
let a: Tenant;
let b: Tenant;

const IMAGE = 'https://cdn.example.com/photo.jpg';
const inOneHour = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

async function addAccount(
  orgId: string,
  workspaceId: string,
  platform: Platform,
  { connected = true } = {},
): Promise<string> {
  return db.withTenant(orgId, async (tx) => {
    const account = await tx.socialAccount.create({
      data: {
        organizationId: orgId,
        workspaceId,
        platform,
        externalAccountId: randomUUID(),
        displayName: `${platform} account`,
      },
    });
    if (connected) {
      // A sealed credential row is what "connected" means; its content does not matter here.
      const key =
        (await tx.organizationKey.findUnique({ where: { organizationId: orgId } })) ??
        (await tx.organizationKey.create({
          data: {
            organizationId: orgId,
            publicKey: randomBytes(32),
            sealedPrivateKey: randomBytes(64),
            masterKeyId: 'mk-test',
          },
        }));
      await tx.oauthCredential.create({
        data: {
          organizationId: orgId,
          socialAccountId: account.id,
          organizationKeyId: key.id,
          sealedTokens: randomBytes(64),
          scopes: [],
        },
      });
    }
    return account.id;
  });
}

async function seedTenant(name: string): Promise<Tenant> {
  const org = await db.createOrganization({ name });
  const [workspaceId, otherWorkspaceId] = await db.withTenant(org.id, async (tx) => {
    const main = await tx.workspace.create({ data: { organizationId: org.id, name: 'Main' } });
    const other = await tx.workspace.create({ data: { organizationId: org.id, name: 'Other' } });
    return [main.id, other.id];
  });
  const member = await signUpUser(app, `${name} member`);
  await addMember(db, org.id, member);
  return {
    orgId: org.id,
    workspaceId,
    otherWorkspaceId,
    member,
    instagramId: await addAccount(org.id, workspaceId, 'instagram'),
  };
}

const call = (
  tenant: Tenant,
  method: 'GET' | 'POST',
  url: string,
  payload?: object,
  key: string | null = randomUUID(),
) =>
  app.inject({
    method,
    url,
    headers: {
      ...asMember(tenant.member, tenant.orgId),
      origin: WEB_ORIGIN,
      ...(key ? { 'idempotency-key': key } : {}),
    },
    ...(payload ? { payload } : {}),
  });

async function createPost(
  tenant: Tenant,
  body = 'Nouvelle collection',
  imageUrl: string | null = IMAGE,
) {
  const res = await call(tenant, 'POST', '/api/v1/posts', {
    workspaceId: tenant.workspaceId,
    body,
    ...(imageUrl ? { imageUrl } : {}),
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string }>().id;
}

const schedule = (
  tenant: Tenant,
  postId: string,
  socialAccountIds: string[],
  scheduledAt = inOneHour(),
  key?: string,
) =>
  call(tenant, 'POST', `/api/v1/posts/${postId}/schedule`, { socialAccountIds, scheduledAt }, key);

const setState = (tenant: Tenant, targetId: string, state: PublicationState) =>
  db.withTenant(tenant.orgId, (tx) =>
    tx.publicationTarget.update({ where: { id: targetId }, data: { state } }),
  );

beforeAll(async () => {
  db = createDb({ connectionString: inject('databaseUrl') });
  app = await createTestApp();
  a = await seedTenant('Sched A');
  b = await seedTenant('Sched B');
});

afterAll(async () => {
  await app.close();
  await db.disconnect();
});

describe('organizations cannot schedule on each other (multi-tenant first)', () => {
  it("A cannot schedule its post on B's account, nor B's post, nor see or cancel B's targets", async () => {
    const postA = await createPost(a);
    const postB = await createPost(b);
    const targetB = (await schedule(b, postB, [b.instagramId])).json<{ items: { id: string }[] }>()
      .items[0]?.id;

    const onOtherAccount = await schedule(a, postA, [b.instagramId]);
    const otherPost = await schedule(a, postB, [a.instagramId]);
    const listOther = await call(a, 'GET', `/api/v1/publication-targets?postId=${postB}`);
    const cancelOther = await call(
      a,
      'POST',
      `/api/v1/publication-targets/${targetB ?? ''}/cancel`,
    );

    expect(onOtherAccount.statusCode).toBe(404);
    expect(otherPost.statusCode).toBe(404);
    expect(listOther.json()).toEqual({ items: [] });
    expect(cancelOther.statusCode).toBe(404);
    // B's target is untouched.
    const stored = await db.withTenant(b.orgId, (tx) =>
      tx.publicationTarget.findUniqueOrThrow({ where: { id: targetB ?? '' } }),
    );
    expect(stored.state).toBe('scheduled');
  });

  it("a post cannot be created in another organization's workspace (404)", async () => {
    const res = await call(a, 'POST', '/api/v1/posts', { workspaceId: b.workspaceId, body: 'x' });
    expect(res.statusCode).toBe(404);
  });
});

describe('creating a post (Idempotency-Key)', () => {
  it('requires the header', async () => {
    const res = await call(
      a,
      'POST',
      '/api/v1/posts',
      { workspaceId: a.workspaceId, body: 'x' },
      null,
    );
    expect(res.statusCode).toBe(400);
    expect(res.json<{ detail: string }>().detail).toContain('idempotency-key');
  });

  it('a retry with the same key gets the same post back, marked as replayed; only one is created', async () => {
    const key = randomUUID();
    const input = { workspaceId: a.workspaceId, body: 'Promo du vendredi', imageUrl: IMAGE };
    const count = () =>
      db.withTenant(a.orgId, (tx) => tx.post.count({ where: { body: input.body } }));

    const first = await call(a, 'POST', '/api/v1/posts', input, key);
    const retry = await call(a, 'POST', '/api/v1/posts', input, key);

    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(201);
    expect(retry.headers[IDEMPOTENT_REPLAYED_HEADER]).toBe('true');
    expect(first.headers[IDEMPOTENT_REPLAYED_HEADER]).toBeUndefined();
    expect(retry.json()).toEqual(first.json());
    expect(first.json()).toMatchObject({ body: input.body, imageUrl: IMAGE });
    expect(await count()).toBe(1);
  });

  it('the same key with a different body is refused (422)', async () => {
    const key = randomUUID();
    await call(a, 'POST', '/api/v1/posts', { workspaceId: a.workspaceId, body: 'one' }, key);
    const other = await call(
      a,
      'POST',
      '/api/v1/posts',
      { workspaceId: a.workspaceId, body: 'two' },
      key,
    );
    expect(other.statusCode).toBe(422);
  });

  it('only HTTPS image URLs are accepted', async () => {
    const res = await call(a, 'POST', '/api/v1/posts', {
      workspaceId: a.workspaceId,
      body: 'x',
      imageUrl: 'http://cdn.example.com/a.jpg',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('scheduling a post', () => {
  it('creates scheduled targets; the scheduler takes it from there', async () => {
    const postId = await createPost(a);
    const scheduledAt = inOneHour();

    const res = await schedule(a, postId, [a.instagramId], scheduledAt);

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      items: [{ postId, socialAccountId: a.instagramId, state: 'scheduled', scheduledAt }],
    });
  });

  it('a retried schedule request replays; a new one moves the time of a still-scheduled target', async () => {
    const postId = await createPost(a);
    const key = randomUUID();
    const at = inOneHour();
    const first = await schedule(a, postId, [a.instagramId], at, key);
    const retry = await schedule(a, postId, [a.instagramId], at, key);
    expect(retry.headers[IDEMPOTENT_REPLAYED_HEADER]).toBe('true');

    const later = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    const moved = await schedule(a, postId, [a.instagramId], later);

    expect(moved.statusCode).toBe(201);
    expect(moved.json<{ items: { id: string; scheduledAt: string }[] }>().items[0]).toEqual(
      expect.objectContaining({
        id: first.json<{ items: { id: string }[] }>().items[0]?.id,
        scheduledAt: later,
      }),
    );
  });

  it('says what to fix (422 issues) and writes nothing', async () => {
    const textOnly = await createPost(a, 'Juste du texte', null);
    const facebookId = await addAccount(a.orgId, a.workspaceId, 'facebook');
    const disconnectedId = await addAccount(a.orgId, a.workspaceId, 'instagram', {
      connected: false,
    });
    const otherWorkspaceId = await addAccount(a.orgId, a.otherWorkspaceId, 'instagram');

    const res = await schedule(
      a,
      textOnly,
      [a.instagramId, facebookId, disconnectedId, otherWorkspaceId],
      new Date(Date.now() - 60_000).toISOString(),
    );

    expect(res.statusCode).toBe(422);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    const issues = res.json<{ issues: { socialAccountId: string | null; code: string }[] }>()
      .issues;
    expect(issues).toEqual(
      expect.arrayContaining([
        { socialAccountId: null, code: 'schedule.in_past' },
        { socialAccountId: a.instagramId, code: 'media.required' },
        { socialAccountId: facebookId, code: 'platform.unavailable' },
        { socialAccountId: disconnectedId, code: 'account.not_connected' },
        { socialAccountId: otherWorkspaceId, code: 'account.other_workspace' },
      ]),
    );
    const targets = await db.withTenant(a.orgId, (tx) =>
      tx.publicationTarget.count({ where: { postId: textOnly } }),
    );
    expect(targets).toBe(0);
  });

  it('a target already handed to the queue cannot be rescheduled (409): it could publish twice', async () => {
    const postId = await createPost(a);
    const targetId =
      (await schedule(a, postId, [a.instagramId])).json<{ items: { id: string }[] }>().items[0]
        ?.id ?? '';

    for (const state of ['queued', 'publishing', 'published'] as const) {
      await setState(a, targetId, state);
      expect((await schedule(a, postId, [a.instagramId])).statusCode).toBe(409);
    }
  });
});

describe('cancelling and reading targets', () => {
  it('cancels a scheduled target (twice is fine), refuses once it is queued', async () => {
    const postId = await createPost(a);
    const targetId =
      (await schedule(a, postId, [a.instagramId])).json<{ items: { id: string }[] }>().items[0]
        ?.id ?? '';

    const cancelled = await call(a, 'POST', `/api/v1/publication-targets/${targetId}/cancel`);
    const again = await call(a, 'POST', `/api/v1/publication-targets/${targetId}/cancel`);
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ id: targetId, state: 'cancelled' });
    expect(again.statusCode).toBe(200);

    await setState(a, targetId, 'queued');
    expect(
      (await call(a, 'POST', `/api/v1/publication-targets/${targetId}/cancel`)).statusCode,
    ).toBe(409);
  });

  it('lists the targets of several posts at once', async () => {
    const first = await createPost(a);
    const second = await createPost(a);
    await schedule(a, first, [a.instagramId]);
    await schedule(a, second, [a.instagramId]);

    const res = await call(
      a,
      'GET',
      `/api/v1/publication-targets?postId=${first}&postId=${second}`,
    );

    expect(res.statusCode).toBe(200);
    expect(
      res
        .json<{ items: { postId: string }[] }>()
        .items.map((t) => t.postId)
        .sort(),
    ).toEqual([first, second].sort());
    expect((await call(a, 'GET', '/api/v1/publication-targets')).statusCode).toBe(400);
  });
});
