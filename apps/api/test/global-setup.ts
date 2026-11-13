import { startTestDatabase, type TestDatabase } from '@ponctua/db/testing';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** app_user connection string of a disposable PostgreSQL with the real migrations. */
    databaseUrl: string;
    /** app_auth connection (Better Auth, schema "auth" only). */
    authDatabaseUrl: string;
  }
}

let database: TestDatabase | undefined;

export async function setup(project: TestProject): Promise<void> {
  database = await startTestDatabase();
  project.provide('databaseUrl', database.appUserUrl);
  project.provide('authDatabaseUrl', database.authUrl);
}

export async function teardown(): Promise<void> {
  await database?.stop();
}
