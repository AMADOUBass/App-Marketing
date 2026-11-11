import { describe, expect, it } from 'vitest';
import { InvalidEnvError, parseEnv } from '../src/config/env.js';

describe('parseEnv', () => {
  it('applies safe defaults', () => {
    expect(parseEnv({})).toEqual({
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: 3000,
      LOG_LEVEL: 'info',
      LOG_PRETTY: false,
    });
  });

  it('coerces string values', () => {
    expect(parseEnv({ PORT: '8080', LOG_PRETTY: 'true' })).toMatchObject({
      PORT: 8080,
      LOG_PRETTY: true,
    });
  });

  it('rejects an invalid PORT with a message naming the variable', () => {
    expect(() => parseEnv({ PORT: 'abc' })).toThrow(InvalidEnvError);
    expect(() => parseEnv({ PORT: 'abc' })).toThrow(/PORT/);
  });

  it('never echoes the rejected value (it could be a secret)', () => {
    let message = '';
    try {
      parseEnv({ LOG_LEVEL: 's3cr3t-value' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('LOG_LEVEL');
    expect(message).not.toContain('s3cr3t-value');
  });
});
