import { inspect } from 'node:util';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { Secret } from '../src/index.js';

const TOKEN = 'IGQVJ-very-secret-token';

describe('Secret', () => {
  const secret = new Secret(TOKEN);

  it('only reveals its value explicitly', () => {
    expect(secret.reveal()).toBe(TOKEN);
  });

  it('prints [REDACTED] in JSON, strings, util.inspect and errors', () => {
    const outputs = [
      JSON.stringify({ accessToken: secret }),
      `token=${String(secret)}`,
      inspect({ accessToken: secret }),
      new Error(`refresh failed for ${String(secret)}`).message,
    ];
    for (const output of outputs) {
      expect(output).not.toContain(TOKEN);
      expect(output).toContain('[REDACTED]');
    }
  });

  it('is redacted in pino logs, even when logged by mistake', () => {
    const lines: string[] = [];
    const logger = pino({}, { write: (line: string) => lines.push(line) });

    logger.info({ credential: { accessToken: secret, refreshToken: secret } }, 'stored');

    expect(lines.join('')).not.toContain(TOKEN);
    expect(lines.join('')).toContain('[REDACTED]');
  });
});
