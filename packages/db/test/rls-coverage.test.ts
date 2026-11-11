import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

// Guard for the future: any new table in the public schema must be tenant-scoped with forced RLS.
// If this test fails, add organization_id + the RLS block to your migration (see the "rls" migration).

const INTERNAL_TABLES = new Set(['_prisma_migrations']);

interface TableInfo {
  table: string;
  rls: boolean;
  forced: boolean;
  hasOrganizationId: boolean;
  policies: string[];
}

let client: pg.Client;

beforeAll(async () => {
  client = new pg.Client({ connectionString: inject('migratorUrl') });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

async function publicTables(): Promise<TableInfo[]> {
  const { rows } = await client.query<TableInfo>(`
    SELECT c.relname AS "table",
           c.relrowsecurity AS rls,
           c.relforcerowsecurity AS forced,
           EXISTS (
             SELECT 1 FROM pg_attribute a
             WHERE a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped
           ) AS "hasOrganizationId",
           COALESCE(
             (SELECT array_agg(p.polname::text) FROM pg_policy p WHERE p.polrelid = c.oid),
             '{}'
           ) AS policies
    FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
    ORDER BY c.relname`);
  return rows.filter((row) => !INTERNAL_TABLES.has(row.table));
}

describe('row-level security coverage', () => {
  it('covers the expected business tables', async () => {
    const tables = (await publicTables()).map((t) => t.table);
    expect(tables).toEqual(
      expect.arrayContaining(['memberships', 'organizations', 'posts', 'workspaces']),
    );
  });

  it('every business table has forced RLS and a tenant_isolation policy', async () => {
    for (const info of await publicTables()) {
      expect({ table: info.table, rls: info.rls, forced: info.forced }).toEqual({
        table: info.table,
        rls: true,
        forced: true,
      });
      expect(info.policies, info.table).toContain('tenant_isolation');
    }
  });

  it('every business table except organizations carries organization_id', async () => {
    for (const info of await publicTables()) {
      if (info.table === 'organizations') continue;
      expect(info.hasOrganizationId, info.table).toBe(true);
    }
  });

  it('cross-organization policies are limited to the reviewed scheduler exceptions (ADR 005)', async () => {
    const allowed: Record<string, string[]> = {
      publication_targets: [
        'scheduler_expire',
        'scheduler_queue',
        'scheduler_read',
        'tenant_isolation',
      ],
    };
    for (const info of await publicTables()) {
      expect([...info.policies].sort(), info.table).toEqual(
        allowed[info.table] ?? ['tenant_isolation'],
      );
    }
  });

  it('SECURITY DEFINER functions are limited to the reviewed scheduler functions (ADR 005)', async () => {
    const { rows } = await client.query<{ name: string; owner: string }>(`
      SELECT p.proname AS name, pg_get_userbyid(p.proowner) AS owner
      FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
      ORDER BY p.proname`);

    expect(rows).toEqual([
      { name: 'claim_due_publication_targets', owner: 'app_scheduler' },
      { name: 'expire_stuck_publications', owner: 'app_scheduler' },
      { name: 'requeue_stale_publication_targets', owner: 'app_scheduler' },
    ]);
  });

  it('the runtime role cannot bypass RLS nor read the migration history', async () => {
    const { rows } = await client.query<{ bypass: boolean; canReadMigrations: boolean }>(`
      SELECT r.rolbypassrls AS bypass,
             has_table_privilege('app_user', '_prisma_migrations', 'SELECT') AS "canReadMigrations"
      FROM pg_roles r WHERE r.rolname = 'app_user'`);

    expect(rows).toEqual([{ bypass: false, canReadMigrations: false }]);
  });
});
