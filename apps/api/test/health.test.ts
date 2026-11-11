import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestEnv } from './helpers.js';

describe('health probes', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/health returns 200 with status ok, without organization', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /api/v1/health/ready returns 200 when the database answers', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health/ready' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('is not served without the version prefix', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });

    expect(res.statusCode).toBe(404);
  });
});

describe('readiness without a database', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    // Port 1 on loopback: nothing listens there.
    app = await createTestApp({
      env: createTestEnv({
        DATABASE_URL: 'postgresql://app_user:x@127.0.0.1:1/app',
        LOG_LEVEL: 'silent',
      }),
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/health/ready returns 503 problem+json without leaking connection details', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health/ready' });

    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).not.toContain('127.0.0.1:1');
    expect(res.body).not.toContain('app_user');
  });

  it('liveness still answers 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(res.statusCode).toBe(200);
  });
});
