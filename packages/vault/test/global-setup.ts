import { startTestDatabase, type TestDatabase } from '@app/db/testing';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    appUserUrl: string;
    /** Schema owner: used only to inspect raw bytes on disk, never by the vault itself. */
    migratorUrl: string;
  }
}

let database: TestDatabase | undefined;

export async function setup(project: TestProject): Promise<void> {
  database = await startTestDatabase();
  project.provide('appUserUrl', database.appUserUrl);
  project.provide('migratorUrl', database.migratorUrl);
}

export async function teardown(): Promise<void> {
  await database?.stop();
}
