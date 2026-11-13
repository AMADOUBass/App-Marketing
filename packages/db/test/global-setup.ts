import type { TestProject } from 'vitest/node';
import { startTestDatabase, type TestDatabase } from '../src/testing.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** app_user: runtime role, subject to RLS. */
    appUserUrl: string;
    /** app_migrator: schema owner (used only to inspect the catalog). */
    migratorUrl: string;
    /** app_auth: Better Auth role, schema "auth" only. */
    authUrl: string;
  }
}

let database: TestDatabase | undefined;

export async function setup(project: TestProject): Promise<void> {
  database = await startTestDatabase();
  project.provide('appUserUrl', database.appUserUrl);
  project.provide('migratorUrl', database.migratorUrl);
  project.provide('authUrl', database.authUrl);
}

export async function teardown(): Promise<void> {
  await database?.stop();
}
