import { Controller, Get } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROBLEM_JSON, ProblemDetailsFilter } from '../src/common/problem-details.filter.js';
import { createTestApp } from './helpers.js';

describe('errors use RFC 9457 problem details', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers an unknown route with 404 application/problem+json', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/does-not-exist?token=abc' });

    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.json()).toMatchObject({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      instance: '/api/v1/does-not-exist',
    });
    expect(res.body).not.toContain('token=abc');
  });
});

@Controller('boom')
class BoomController {
  @Get()
  explode(): never {
    throw new Error('database password is hunter2');
  }
}

describe('unexpected errors', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [BoomController],
      providers: [{ provide: APP_FILTER, useClass: ProblemDetailsFilter }],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns a generic 500 without leaking the internal message', async () => {
    const res = await app.inject({ method: 'GET', url: '/boom' });

    expect(res.statusCode).toBe(500);
    expect(res.headers['content-type']).toMatch(new RegExp(`^${PROBLEM_JSON.replace('+', '\\+')}`));
    expect(res.json()).toEqual({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      instance: '/boom',
    });
    expect(res.body).not.toContain('hunter2');
  });
});
