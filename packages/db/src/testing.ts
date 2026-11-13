// Test-only helper (import from '@ponctua/db/testing'): a disposable PostgreSQL 18 with the real roles
// and migrations. Requires Docker. @testcontainers/postgresql is a dev dependency of this package,
// so this entry point must never be imported by production code.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

// Same image and role bootstrap script as infra/compose, so tests run against the real setup.
const POSTGRES_IMAGE = 'postgres:18.6-alpine3.24';
const PACKAGE_ROOT = resolve(import.meta.dirname, '..');
const INIT_DIR = resolve(PACKAGE_ROOT, '../../infra/compose/postgres/init');
const INIT_SCRIPTS = ['01-roles.sh', '02-scheduler-role.sh', '03-identity-roles.sh'];
const PASSWORDS = { migrator: 'migrator_test', appUser: 'app_user_test', auth: 'app_auth_test' };

export interface TestDatabase {
  /** app_user: runtime role, subject to RLS. */
  appUserUrl: string;
  /** app_migrator: schema owner. */
  migratorUrl: string;
  /** app_auth: Better Auth, schema "auth" only (ADR 008). */
  authUrl: string;
  stop(): Promise<void>;
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withEnvironment({
      APP_DB_NAME: 'app',
      APP_MIGRATOR_PASSWORD: PASSWORDS.migrator,
      APP_USER_PASSWORD: PASSWORDS.appUser,
      APP_AUTH_PASSWORD: PASSWORDS.auth,
    })
    .withCopyFilesToContainer(
      INIT_SCRIPTS.map((name) => ({
        source: resolve(INIT_DIR, name),
        target: `/docker-entrypoint-initdb.d/${name}`,
        mode: 0o755,
      })),
    )
    .start();

  const address = `${container.getHost()}:${String(container.getPort())}`;
  const migratorUrl = `postgresql://app_migrator:${PASSWORDS.migrator}@${address}/app`;
  const appUserUrl = `postgresql://app_user:${PASSWORDS.appUser}@${address}/app`;
  const authUrl = `postgresql://app_auth:${PASSWORDS.auth}@${address}/app`;

  // Apply the real migrations (schema + RLS) exactly as in production.
  const prismaCli = join(
    dirname(createRequire(import.meta.url).resolve('prisma/package.json')),
    'build/index.js',
  );
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, MIGRATION_DATABASE_URL: migratorUrl },
    stdio: 'pipe',
  });

  return {
    appUserUrl,
    migratorUrl,
    authUrl,
    stop: async () => {
      await container.stop();
    },
  };
}
