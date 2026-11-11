// Test-only helper (import from '@app/db/testing'): a disposable PostgreSQL 18 with the real roles
// and migrations. Requires Docker. @testcontainers/postgresql is a dev dependency of this package,
// so this entry point must never be imported by production code.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

// Same image and role bootstrap script as infra/compose, so tests run against the real setup.
const POSTGRES_IMAGE = 'postgres:18.6-alpine3.24';
const PACKAGE_ROOT = resolve(import.meta.dirname, '..');
const ROLES_SCRIPT = resolve(PACKAGE_ROOT, '../../infra/compose/postgres/init/01-roles.sh');
const PASSWORDS = { migrator: 'migrator_test', appUser: 'app_user_test' };

export interface TestDatabase {
  /** app_user: runtime role, subject to RLS. */
  appUserUrl: string;
  /** app_migrator: schema owner. */
  migratorUrl: string;
  stop(): Promise<void>;
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withEnvironment({
      APP_DB_NAME: 'app',
      APP_MIGRATOR_PASSWORD: PASSWORDS.migrator,
      APP_USER_PASSWORD: PASSWORDS.appUser,
    })
    .withCopyFilesToContainer([
      { source: ROLES_SCRIPT, target: '/docker-entrypoint-initdb.d/01-roles.sh', mode: 0o755 },
    ])
    .start();

  const address = `${container.getHost()}:${String(container.getPort())}`;
  const migratorUrl = `postgresql://app_migrator:${PASSWORDS.migrator}@${address}/app`;
  const appUserUrl = `postgresql://app_user:${PASSWORDS.appUser}@${address}/app`;

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
    stop: async () => {
      await container.stop();
    },
  };
}
