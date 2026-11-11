import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** app_user: runtime role, subject to RLS. */
    appUserUrl: string;
    /** app_migrator: schema owner (used only to inspect the catalog). */
    migratorUrl: string;
  }
}

// Same image and role bootstrap script as infra/compose, so tests run against the real setup.
const POSTGRES_IMAGE = 'postgres:18.6-alpine3.24';
const ROLES_SCRIPT = resolve(
  import.meta.dirname,
  '../../../infra/compose/postgres/init/01-roles.sh',
);
const PASSWORDS = { migrator: 'migrator_test', appUser: 'app_user_test' };

let container: StartedPostgreSqlContainer | undefined;

export async function setup(project: TestProject): Promise<void> {
  container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withEnvironment({
      APP_DB_NAME: 'app',
      APP_MIGRATOR_PASSWORD: PASSWORDS.migrator,
      APP_USER_PASSWORD: PASSWORDS.appUser,
    })
    .withCopyFilesToContainer([
      { source: ROLES_SCRIPT, target: '/docker-entrypoint-initdb.d/01-roles.sh', mode: 0o755 },
    ])
    .start();

  const host = container.getHost();
  const port = String(container.getPort());
  const migratorUrl = `postgresql://app_migrator:${PASSWORDS.migrator}@${host}:${port}/app`;
  const appUserUrl = `postgresql://app_user:${PASSWORDS.appUser}@${host}:${port}/app`;

  // Apply the real migrations (schema + RLS) exactly as in production.
  const prismaCli = join(
    dirname(createRequire(import.meta.url).resolve('prisma/package.json')),
    'build/index.js',
  );
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, MIGRATION_DATABASE_URL: migratorUrl },
    stdio: 'pipe',
  });

  project.provide('appUserUrl', appUserUrl);
  project.provide('migratorUrl', migratorUrl);
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
