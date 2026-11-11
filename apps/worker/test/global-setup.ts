import { startTestDatabase, type TestDatabase } from '@app/db/testing';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    valkeyUrl: string;
  }
}

// Same image as infra/compose.
const VALKEY_IMAGE = 'valkey/valkey:8.1.11-alpine';

let database: TestDatabase | undefined;
let valkey: StartedTestContainer | undefined;

export async function setup(project: TestProject): Promise<void> {
  [database, valkey] = await Promise.all([
    startTestDatabase(),
    new GenericContainer(VALKEY_IMAGE)
      .withCommand(['valkey-server', '--maxmemory-policy', 'noeviction'])
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start(),
  ]);
  project.provide('databaseUrl', database.appUserUrl);
  project.provide('valkeyUrl', `redis://${valkey.getHost()}:${String(valkey.getMappedPort(6379))}`);
}

export async function teardown(): Promise<void> {
  await Promise.all([database?.stop(), valkey?.stop()]);
}
