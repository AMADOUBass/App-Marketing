import { describe, expect, inject, it } from 'vitest';
import { createDb, DatabaseUnavailableError } from '../src/index.js';

describe('db.ping', () => {
  it('resolves when the database answers', async () => {
    const db = createDb({ connectionString: inject('appUserUrl') });
    try {
      await expect(db.ping()).resolves.toBeUndefined();
    } finally {
      await db.disconnect();
    }
  });

  it('rejects with DatabaseUnavailableError when the database is unreachable', async () => {
    // Port 1 on loopback: nothing listens there.
    const db = createDb({ connectionString: 'postgresql://app_user:x@127.0.0.1:1/app' });
    try {
      await expect(db.ping(1000)).rejects.toThrow(DatabaseUnavailableError);
    } finally {
      await db.disconnect();
    }
  });
});
