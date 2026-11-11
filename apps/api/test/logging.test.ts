import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogCapture, createTestApp } from './helpers.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('request logging', () => {
  const logs = createLogCapture();
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createTestApp({ logStream: logs.stream });
  });

  beforeEach(() => {
    logs.raw.length = 0;
  });

  afterAll(async () => {
    await app.close();
  });

  it('never writes credentials, query strings or IP addresses', async () => {
    await app.inject({
      method: 'GET',
      url: '/api/v1/oauth/callback?code=secret-oauth-code-000',
      remoteAddress: '203.0.113.7',
      headers: {
        authorization: 'Bearer secret-token-123',
        cookie: 'session=secret-cookie-456',
        'x-api-key': 'secret-key-789',
      },
    });

    const output = logs.raw.join('');
    expect(output).toContain('request completed');
    for (const secret of [
      'secret-token-123',
      'secret-cookie-456',
      'secret-key-789',
      'secret-oauth-code-000',
      '203.0.113.7',
    ]) {
      expect(output).not.toContain(secret);
    }
  });

  it('writes structured JSON with request id, method, path and status', async () => {
    await app.inject({ method: 'GET', url: '/api/v1/does-not-exist?x=1' });

    const completed = logs.entries().find((entry) => entry.msg === 'request completed');
    expect(completed?.req).toEqual({
      id: expect.stringMatching(UUID) as unknown,
      method: 'GET',
      url: '/api/v1/does-not-exist',
    });
    expect(completed?.res).toEqual({ statusCode: 404 });
  });

  it('reuses a safe incoming x-request-id and echoes it back', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { 'x-request-id': 'client-req_42' },
    });

    expect(res.headers['x-request-id']).toBe('client-req_42');
  });

  it('replaces an unsafe incoming x-request-id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { 'x-request-id': 'bad id\nfake log line' },
    });

    expect(res.headers['x-request-id']).toMatch(UUID);
  });

  it('does not log health probes', async () => {
    await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(logs.raw).toHaveLength(0);
  });
});
