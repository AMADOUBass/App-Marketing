import { randomUUIDv7 } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';

/** Creates an identity row the way Better Auth would (as app_auth, schema "auth"). Returns its id. */
export async function createTestUser(
  email = `${randomUUIDv7()}@test.ponctua.local`,
): Promise<string> {
  const client = new pg.Client({ connectionString: inject('authUrl') });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string }>(
      'INSERT INTO auth.users (name, email) VALUES ($1, $2) RETURNING id',
      ['Test user', email],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('user not created');
    return id;
  } finally {
    await client.end();
  }
}
