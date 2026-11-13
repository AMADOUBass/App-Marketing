import { Secret } from '@ponctua/vault';
import { describe, expect, it, vi } from 'vitest';
import { createInstagramAdapter, instagramCapabilities, type PublishJob } from '../src/index.js';
import { createFakeGraph } from './fake-graph.js';
import {
  CONTAINER_ID,
  containerCreated,
  containerStatus,
  errors,
  IG_USER_ID,
  MEDIA_ID,
  published,
  quota,
} from './fixtures/instagram.js';

const TOKEN = 'EAAG-system-user-token-must-never-leak';
const MEDIA = /\/v27\.0\/\d+\/media$/;
const PUBLISH = /\/media_publish$/;
const STATUS = new RegExp(`/v27\\.0/${CONTAINER_ID}$`);
const QUOTA = /\/content_publishing_limit$/;

function job(overrides: Partial<PublishJob['variant']> = {}): PublishJob {
  return {
    remoteAccountId: IG_USER_ID,
    accessToken: new Secret(TOKEN),
    variant: {
      caption: 'Nouveau croissant aux amandes 🥐',
      imageUrl: 'https://media.example.com/croissant.jpg',
      mimeType: 'image/jpeg',
      ...overrides,
    },
  };
}

function setup() {
  const graph = createFakeGraph();
  const sleep = vi.fn(() => Promise.resolve());
  const adapter = createInstagramAdapter({ fetch: graph.fetch, sleep });
  return { graph, sleep, adapter };
}

describe('validate (pure, no network)', () => {
  const { adapter } = setup();
  const check = (variant: Partial<PublishJob['variant']>) =>
    adapter.validate(job(variant).variant, instagramCapabilities).map((i) => i.code);

  it('accepts a public HTTPS JPEG', () => {
    expect(check({})).toEqual([]);
  });

  it('rejects non-JPEG, non-HTTPS, private hosts, oversized and badly shaped images', () => {
    expect(check({ mimeType: 'image/png' })).toEqual(['image.format']);
    expect(check({ imageUrl: 'http://media.example.com/a.jpg' })).toEqual(['image.url_not_https']);
    expect(check({ imageUrl: 'https://localhost:9000/media/a.jpg' })).toEqual([
      'image.url_not_public',
    ]);
    expect(check({ imageUrl: 'https://192.168.1.20/a.jpg' })).toEqual(['image.url_not_public']);
    expect(check({ sizeBytes: 9 * 1024 * 1024 })).toEqual(['image.too_large']);
    expect(check({ widthPx: 1000, heightPx: 3000 })).toEqual(['image.aspect_ratio']);
    expect(check({ widthPx: 1080, heightPx: 1350 })).toEqual([]); // 4:5 is allowed
  });

  it('enforces no caption limit while the docs state none (rule 5)', () => {
    expect(check({ caption: 'x'.repeat(10_000) })).toEqual([]);
  });
});

describe('publish', () => {
  it('quota -> container -> status -> publish, with the token only in the Authorization header', async () => {
    const { graph, adapter } = setup();
    graph
      .on('GET', QUOTA, { json: quota(2) })
      .on('POST', MEDIA, { json: containerCreated })
      .on('GET', STATUS, { json: containerStatus('FINISHED') })
      .on('POST', PUBLISH, { json: published });
    const stored: string[] = [];

    const outcome = await adapter.publish(job(), {
      onContainerCreated: (id) => {
        stored.push(id);
      },
    });

    expect(outcome).toEqual({
      status: 'published',
      containerId: CONTAINER_ID,
      remoteMediaId: MEDIA_ID,
    });
    expect(stored).toEqual([CONTAINER_ID]);
    expect(
      graph.requests.map((r) => `${r.method} ${r.url.pathname.replace('/v27.0', '')}`),
    ).toEqual([
      `GET /${IG_USER_ID}/content_publishing_limit`,
      `POST /${IG_USER_ID}/media`,
      `GET /${CONTAINER_ID}`,
      `POST /${IG_USER_ID}/media_publish`,
    ]);
    expect(graph.calls('POST', MEDIA)[0]?.body?.get('image_url')).toBe(job().variant.imageUrl);
    expect(graph.calls('POST', PUBLISH)[0]?.body?.get('creation_id')).toBe(CONTAINER_ID);
    for (const request of graph.requests) {
      expect(request.url.toString()).not.toContain(TOKEN);
      expect(request.url.searchParams.has('access_token')).toBe(false);
      expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(request.url.origin).toBe('https://graph.facebook.com');
    }
  });

  it('waits for the container once per minute, as documented', async () => {
    const { graph, adapter, sleep } = setup();
    graph
      .on('GET', QUOTA, { json: quota(0) })
      .on('POST', MEDIA, { json: containerCreated })
      .on(
        'GET',
        STATUS,
        { json: containerStatus('IN_PROGRESS') },
        { json: containerStatus('IN_PROGRESS') },
        { json: containerStatus('FINISHED') },
      )
      .on('POST', PUBLISH, { json: published });

    expect((await adapter.publish(job())).status).toBe('published');
    expect(sleep.mock.calls).toEqual([[60_000], [60_000]]);
  });

  it('gives up after 5 minutes in progress without ever calling media_publish', async () => {
    const { graph, adapter } = setup();
    graph
      .on('GET', QUOTA, { json: quota(0) })
      .on('POST', MEDIA, { json: containerCreated })
      .on('GET', STATUS, { json: containerStatus('IN_PROGRESS') });

    const outcome = await adapter.publish(job());

    expect(outcome).toMatchObject({ status: 'failed', errorClass: 'transient', retryable: true });
    expect(graph.calls('GET', STATUS).length).toBeLessThanOrEqual(6);
    expect(graph.calls('POST', PUBLISH)).toEqual([]);
  });

  it('does not create anything when the live quota is used up', async () => {
    const { graph, adapter } = setup();
    graph.on('GET', QUOTA, { json: quota(50, 50) });

    expect(await adapter.publish(job())).toMatchObject({
      status: 'failed',
      errorClass: 'quota',
      retryable: true,
      containerId: null,
    });
    expect(graph.requests.filter((r) => r.method === 'POST')).toEqual([]);
  });

  it('uses the live quota total, not a hardcoded limit', async () => {
    const { graph, adapter } = setup();
    graph
      .on('GET', QUOTA, { json: quota(60, 100) })
      .on('POST', MEDIA, { json: containerCreated })
      .on('GET', STATUS, { json: containerStatus('FINISHED') })
      .on('POST', PUBLISH, { json: published });

    expect((await adapter.publish(job())).status).toBe('published');
  });

  it.each([
    ['ERROR', 'unknown', false],
    ['EXPIRED', 'transient', true],
  ])('container %s -> failed (%s)', async (statusCode, errorClass, retryable) => {
    const { graph, adapter } = setup();
    graph
      .on('GET', QUOTA, { json: quota(0) })
      .on('POST', MEDIA, { json: containerCreated })
      .on('GET', STATUS, { json: containerStatus(statusCode) });

    expect(await adapter.publish(job())).toMatchObject({ status: 'failed', errorClass, retryable });
    expect(graph.calls('POST', PUBLISH)).toEqual([]);
  });

  it('an unreachable image fails as content (not retried), without echoing the signed URL', async () => {
    const { graph, adapter } = setup();
    graph
      .on('GET', QUOTA, { json: quota(0) })
      .on('POST', MEDIA, { status: 400, json: errors.mediaNotFetchable });

    const outcome = await adapter.publish(job());

    expect(outcome).toMatchObject({
      status: 'failed',
      errorClass: 'content',
      retryable: false,
      containerId: null,
    });
    expect(JSON.stringify(outcome)).not.toContain('X-Amz-Signature');
  });

  it('a platform error on media_publish is a certain failure, not unknown', async () => {
    const { graph, adapter } = setup();
    graph
      .on('GET', QUOTA, { json: quota(0) })
      .on('POST', MEDIA, { json: containerCreated })
      .on('GET', STATUS, { json: containerStatus('FINISHED') })
      .on('POST', PUBLISH, { status: 400, json: errors.quotaReached });

    expect(await adapter.publish(job())).toMatchObject({
      status: 'failed',
      errorClass: 'quota',
      containerId: CONTAINER_ID,
    });
  });

  it.each([
    ['no answer (timeout, connection reset)', { networkError: true } as const],
    ['a success answer that cannot be read', { json: { unexpected: true } }],
  ])('%s on media_publish -> unknown_outcome, reconcile before anything else', async (_, reply) => {
    const { graph, adapter } = setup();
    graph
      .on('GET', QUOTA, { json: quota(0) })
      .on('POST', MEDIA, { json: containerCreated })
      .on('GET', STATUS, { json: containerStatus('FINISHED') })
      .on('POST', PUBLISH, reply);

    expect(await adapter.publish(job())).toEqual({
      status: 'unknown_outcome',
      containerId: CONTAINER_ID,
    });
  });

  it('never puts the token in an outcome, whatever goes wrong', async () => {
    const scenarios = [
      [{ status: 400, json: errors.tokenExpired }],
      [{ networkError: true } as const],
      [{ status: 500, json: { error: { message: `bad token ${TOKEN}` } } }],
    ];
    for (const replies of scenarios) {
      const { graph, adapter } = setup();
      graph.on('GET', QUOTA, ...replies);
      const outcome = await adapter.publish(job());
      expect(JSON.stringify(outcome)).not.toContain(TOKEN);
    }
  });
});

describe('reconcile (after unknown_outcome): reads the container, never publishes', () => {
  it.each([
    ['PUBLISHED', { status: 'published', containerId: CONTAINER_ID, remoteMediaId: null }],
    ['FINISHED', { status: 'failed', errorClass: 'transient', retryable: true }],
    ['EXPIRED', { status: 'failed', errorClass: 'transient', retryable: true }],
    ['ERROR', { status: 'failed', errorClass: 'unknown', retryable: false }],
  ])('container %s', async (statusCode, expected) => {
    const { graph, adapter } = setup();
    graph.on('GET', STATUS, { json: containerStatus(statusCode) });

    expect(await adapter.reconcile(CONTAINER_ID, new Secret(TOKEN))).toMatchObject(expected);
    expect(graph.requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('stays unknown (null) while in progress or when the platform does not answer', async () => {
    const inProgress = setup();
    inProgress.graph.on('GET', STATUS, { json: containerStatus('IN_PROGRESS') });
    expect(await inProgress.adapter.reconcile(CONTAINER_ID, new Secret(TOKEN))).toBeNull();

    const offline = setup();
    offline.graph.on('GET', STATUS, { networkError: true });
    expect(await offline.adapter.reconcile(CONTAINER_ID, new Secret(TOKEN))).toBeNull();
  });
});
