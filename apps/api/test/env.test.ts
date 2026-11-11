import { describe, expect, it } from 'vitest';
import { InvalidEnvError, parseEnv } from '../src/config/env.js';

const DATABASE_URL = 'postgresql://app_user:secret@127.0.0.1:5432/app';

describe('parseEnv', () => {
  it('applies safe defaults', () => {
    expect(parseEnv({ DATABASE_URL })).toEqual({
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: 3000,
      LOG_LEVEL: 'info',
      LOG_PRETTY: false,
      DATABASE_URL,
      DEV_TENANT_HEADER: false,
    });
  });

  it('coerces string values', () => {
    expect(parseEnv({ DATABASE_URL, PORT: '8080', LOG_PRETTY: 'true' })).toMatchObject({
      PORT: 8080,
      LOG_PRETTY: true,
    });
  });

  it('rejects an invalid PORT with a message naming the variable', () => {
    expect(() => parseEnv({ DATABASE_URL, PORT: 'abc' })).toThrow(InvalidEnvError);
    expect(() => parseEnv({ DATABASE_URL, PORT: 'abc' })).toThrow(/PORT/);
  });

  it('requires a PostgreSQL DATABASE_URL', () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
    expect(() => parseEnv({ DATABASE_URL: 'mysql://u:p@h/db' })).toThrow(/DATABASE_URL/);
  });

  it('never echoes the rejected value (it could be a secret)', () => {
    let message = '';
    try {
      parseEnv({ DATABASE_URL: 's3cr3t-value', LOG_LEVEL: 's3cr3t-level' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('LOG_LEVEL');
    expect(message).not.toContain('s3cr3t');
  });

  it('refuses the dev tenant header in production', () => {
    expect(() =>
      parseEnv({ DATABASE_URL, NODE_ENV: 'production', DEV_TENANT_HEADER: 'true' }),
    ).toThrow(/DEV_TENANT_HEADER/);
    expect(parseEnv({ DATABASE_URL, NODE_ENV: 'production' }).DEV_TENANT_HEADER).toBe(false);
  });
});
