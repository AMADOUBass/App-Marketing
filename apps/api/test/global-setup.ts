import { startTestDatabase, type TestDatabase } from '@app/db/testing';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** app_user connection string of a disposable PostgreSQL with the real migrations. */
    databaseUrl: string;
  }
}

let database: TestDatabase | undefined;

export async function setup(project: TestProject): Promise<void> {
  database = await startTestDatabase();
  project.provide('databaseUrl', database.appUserUrl);
}

export async function teardown(): Promise<void> {
  await database?.stop();
}
