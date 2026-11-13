import { describe, expect, it } from 'vitest';
import { InvalidEnvError, parseEnv } from '../src/config/env.js';

const DATABASE_URL = 'postgresql://app_user:secret@127.0.0.1:5432/app';
/** Required authentication settings (ADR 008). */
const AUTH = {
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  BETTER_AUTH_URL: 'http://localhost:5173',
  AUTH_DATABASE_URL: 'postgresql://app_auth:secret@127.0.0.1:5432/app',
  SMTP_URL: 'smtp://127.0.0.1:1025',
};

describe('parseEnv', () => {
  it('applies safe defaults', () => {
    const env = parseEnv({ DATABASE_URL, ...AUTH });
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: 3000,
      LOG_LEVEL: 'info',
      LOG_PRETTY: false,
      DATABASE_URL,
      BETTER_AUTH_URL: 'http://localhost:5173',
      TRUSTED_ORIGINS: [],
    });
    // The secret is wrapped: it never prints.
    expect(String(env.BETTER_AUTH_SECRET)).not.toContain('xxxx');
  });

  it('requires an SMTP URL and never prints it (it may carry credentials)', () => {
    const { SMTP_URL: _smtp, ...withoutSmtp } = AUTH;
    expect(() => parseEnv({ DATABASE_URL, ...withoutSmtp })).toThrow(/SMTP_URL/);
    expect(() => parseEnv({ DATABASE_URL, ...AUTH, SMTP_URL: 'http://mail' })).toThrow(/SMTP_URL/);
    const env = parseEnv({ DATABASE_URL, ...AUTH, SMTP_URL: 'smtps://user:pa55word@smtp.example' });
    expect(JSON.stringify(env)).not.toContain('pa55word');
    expect(env.MAIL_FROM).toBe('Ponctua <no-reply@ponctua.local>');
  });

  it('requires the authentication settings', () => {
    expect(() => parseEnv({ DATABASE_URL })).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => parseEnv({ DATABASE_URL, ...AUTH, BETTER_AUTH_SECRET: 'too-short' })).toThrow(
      /BETTER_AUTH_SECRET/,
    );
    expect(
      parseEnv({ DATABASE_URL, ...AUTH, TRUSTED_ORIGINS: 'http://a.test, http://b.test' })
        .TRUSTED_ORIGINS,
    ).toEqual(['http://a.test', 'http://b.test']);
  });

  it('coerces string values', () => {
    expect(parseEnv({ DATABASE_URL, ...AUTH, PORT: '8080', LOG_PRETTY: 'true' })).toMatchObject({
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

  it('a leftover DEV_TENANT_HEADER (removed, ADR 008) is ignored and enables nothing', () => {
    const env = parseEnv({ DATABASE_URL, ...AUTH, DEV_TENANT_HEADER: 'true' });
    expect(env).not.toHaveProperty('DEV_TENANT_HEADER');
  });
});
