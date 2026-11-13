import { generateKeyPairSync } from 'node:crypto';
import type { FetchLike } from '@ponctua/integrations';
import { Secret } from '@ponctua/vault';
import { createVaultSealer } from '@ponctua/vault/seal';
import type { INestApplicationContext } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PublishProcessor } from '../src/publish/publish.processor.js';
import { createSeeder, createTestEnv, type Fixture, startWorker } from './helpers.js';

const IG_ACCOUNT_ID = '17841472428926955';
const CONTAINER_ID = '17889615691921648';
const MEDIA_ID = '17920238422030506';
const TOKEN = 'EAAG-worker-token-never-in-clear';

const pair = generateKeyPairSync('x25519');
const master = {
  id: 'mk-test',
  publicKey: pair.publicKey.export({ format: 'jwk' }).x ?? '',
  privateKey: pair.privateKey.export({ format: 'jwk' }).d ?? '',
};

type Step = 'quota' | 'media' | 'status' | 'publish';
type Behaviour = Partial<Record<Step, { status?: number; json?: unknown; networkError?: boolean }>>;

/** Fake Graph API following the documented publishing flow. */
function fakeGraph(behaviour: Behaviour = {}) {
  const calls: { step: Step; authorization: string | null; url: string }[] = [];
  const defaults: Record<Step, { status?: number; json?: unknown; networkError?: boolean }> = {
    quota: {
      json: { data: [{ quota_usage: 1, config: { quota_total: 50, quota_duration: 86400 } }] },
    },
    media: { json: { id: CONTAINER_ID } },
    status: { json: { status_code: 'FINISHED', id: CONTAINER_ID } },
    publish: { json: { id: MEDIA_ID } },
  };
  const fetchImpl: FetchLike = (input, init) => {
    const url = new URL(input);
    const step: Step = url.pathname.endsWith('/content_publishing_limit')
      ? 'quota'
      : url.pathname.endsWith('/media_publish')
        ? 'publish'
        : url.pathname.endsWith('/media')
          ? 'media'
          : 'status';
    calls.push({
      step,
      authorization: new Headers(init?.headers).get('authorization'),
      url: url.toString(),
    });
    const reply = { ...defaults[step], ...behaviour[step] };
    if (reply.networkError) return Promise.reject(new TypeError('fetch failed'));
    return Promise.resolve(
      new Response(JSON.stringify(reply.json), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetchImpl, calls };
}

const seed = createSeeder();
const running: INestApplicationContext[] = [];
let a: Fixture;

beforeAll(async () => {
  a = await seed.org('Org A');
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((app) => app.close()));
});

afterAll(async () => {
  await seed.db.disconnect();
});

/** A queued target for an Instagram account with a sealed token (as the API's OAuth callback stores it). */
async function instagramTarget(options: { connected?: boolean; imageUrl?: string | null } = {}) {
  const { connected = true, imageUrl = 'https://media.example.com/croissant.jpg' } = options;
  return seed.db.withTenant(a.orgId, async (tx) => {
    const account = await tx.socialAccount.create({
      data: {
        organizationId: a.orgId,
        workspaceId: a.workspaceId,
        platform: 'instagram',
        externalAccountId: `${IG_ACCOUNT_ID}-${String(Math.random()).slice(2, 8)}`,
        displayName: 'abassoum88888',
      },
    });
    if (connected) {
      await createVaultSealer({
        masterKeyId: master.id,
        masterPublicKey: master.publicKey,
      }).storeCredential(tx, {
        organizationId: a.orgId,
        socialAccountId: account.id,
        tokens: { accessToken: new Secret(TOKEN), refreshToken: null },
        scopes: ['instagram_basic', 'instagram_content_publish'],
        expiresAt: null,
      });
    }
    const post = await tx.post.create({
      data: {
        organizationId: a.orgId,
        workspaceId: a.workspaceId,
        body: 'Nouveau croissant 🥐',
        imageUrl,
      },
    });
    const target = await tx.publicationTarget.create({
      data: {
        organizationId: a.orgId,
        postId: post.id,
        socialAccountId: account.id,
        state: 'queued',
        queuedAt: new Date(),
        attemptCount: 1,
      },
    });
    return { targetId: target.id, externalAccountId: account.externalAccountId };
  });
}

async function processorWith(graph: ReturnType<typeof fakeGraph>, enabled = true) {
  const env = createTestEnv('publish', {
    INSTAGRAM_PUBLISHING_ENABLED: String(enabled),
    VAULT_MASTER_PRIVATE_KEYS: `${master.id}:${master.privateKey}`,
  });
  const app = await startWorker(env, undefined, { graphFetch: graph.fetchImpl });
  running.push(app);
  return app.get(PublishProcessor);
}

const attemptOf = (targetId: string) =>
  seed.db.withTenant(a.orgId, (tx) => tx.publishAttempt.findFirstOrThrow({ where: { targetId } }));

const run = (processor: PublishProcessor, targetId: string) =>
  processor.process({ organizationId: a.orgId, targetId, attemptNo: 1 });

describe('Instagram publishing in the worker', () => {
  it('opens the sealed token in the worker and publishes; published only once Instagram confirms', async () => {
    const graph = fakeGraph();
    const processor = await processorWith(graph);
    const { targetId, externalAccountId } = await instagramTarget();

    expect(await run(processor, targetId)).toBe('published');

    expect(graph.calls.map((c) => c.step)).toEqual(['quota', 'media', 'status', 'publish']);
    expect(graph.calls.every((c) => c.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(graph.calls[1]?.url).toContain(`/${externalAccountId}/media`);
    expect(await seed.state(a, targetId)).toBe('published');
    const attempt = await attemptOf(targetId);
    expect(attempt).toMatchObject({
      outcome: 'published',
      errorClass: null,
      response: { containerId: CONTAINER_ID, remoteMediaId: MEDIA_ID },
    });
    expect(JSON.stringify(attempt)).not.toContain(TOKEN);
  });

  it('no answer to media_publish -> unknown_outcome, with the container id kept for reconciliation', async () => {
    const processor = await processorWith(fakeGraph({ publish: { networkError: true } }));
    const { targetId } = await instagramTarget();

    expect(await run(processor, targetId)).toBe('unknown_outcome');
    expect(await attemptOf(targetId)).toMatchObject({
      outcome: 'unknown_outcome',
      errorClass: 'unknown',
      response: { containerId: CONTAINER_ID },
    });
  });

  it('an invalid token (190) -> needs_action: the client must reconnect, no blind retry', async () => {
    const processor = await processorWith(
      fakeGraph({
        quota: {
          status: 400,
          json: { error: { message: 'Invalid token', type: 'OAuthException', code: 190 } },
        },
      }),
    );
    const { targetId } = await instagramTarget();

    expect(await run(processor, targetId)).toBe('needs_action');
    expect(await attemptOf(targetId)).toMatchObject({ errorClass: 'auth' });
  });

  it('an unreachable image -> failed (content), never published', async () => {
    const graph = fakeGraph({
      media: {
        status: 400,
        json: {
          error: {
            message: 'cannot fetch',
            type: 'OAuthException',
            code: 9004,
            error_subcode: 2207052,
          },
        },
      },
    });
    const processor = await processorWith(graph);
    const { targetId } = await instagramTarget();

    expect(await run(processor, targetId)).toBe('failed');
    expect(await attemptOf(targetId)).toMatchObject({ errorClass: 'content' });
    expect(graph.calls.map((c) => c.step)).not.toContain('publish');
  });

  it('an account without a sealed token -> needs_action, without calling Instagram', async () => {
    const graph = fakeGraph();
    const processor = await processorWith(graph);
    const { targetId } = await instagramTarget({ connected: false });

    expect(await run(processor, targetId)).toBe('needs_action');
    expect(graph.calls).toEqual([]);
  });

  it('a post without image -> failed (content), without calling Instagram', async () => {
    const graph = fakeGraph();
    const processor = await processorWith(graph);
    const { targetId } = await instagramTarget({ imageUrl: null });

    expect(await run(processor, targetId)).toBe('failed');
    expect(graph.calls).toEqual([]);
  });

  it('feature flag off -> needs_action, nothing is sent to Instagram', async () => {
    const graph = fakeGraph();
    const processor = await processorWith(graph, false);
    const { targetId } = await instagramTarget();

    expect(await run(processor, targetId)).toBe('needs_action');
    expect(graph.calls).toEqual([]);
  });

  it('enabling the flag without the vault private keys is refused at startup', () => {
    expect(() => createTestEnv('publish', { INSTAGRAM_PUBLISHING_ENABLED: 'true' })).toThrow(
      /VAULT_MASTER_PRIVATE_KEYS/,
    );
    const env = createTestEnv('publish', {
      INSTAGRAM_PUBLISHING_ENABLED: 'true',
      VAULT_MASTER_PRIVATE_KEYS: `${master.id}:${master.privateKey}`,
    });
    expect(JSON.stringify(env)).not.toContain(master.privateKey);
  });
});
