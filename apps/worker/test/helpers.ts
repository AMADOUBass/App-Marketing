import { randomUUIDv7 } from 'node:crypto';
import { createDb, type Db, type PublicationState } from '@app/db';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { inject } from 'vitest';
import { type Env, parseEnv, type ProcessRole } from '../src/config/env.js';
import type {
  PublishHandler,
  PublishOutcomeState,
  PublishTarget,
} from '../src/publish/publish-handler.js';
import { WorkerModule } from '../src/worker.module.js';

/** Fast ticks and a unique namespace per call, so tests do not share queues or locks. */
export function createTestEnv(role: ProcessRole, overrides: Record<string, string> = {}): Env {
  return parseEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PROCESS_ROLE: role,
    DATABASE_URL: inject('databaseUrl'),
    VALKEY_URL: inject('valkeyUrl'),
    QUEUE_PREFIX: `t${randomUUIDv7().replaceAll('-', '')}`,
    SCHEDULER_TICK_MS: '100',
    LEADER_LOCK_TTL_MS: '1000',
    ...overrides,
  });
}

export async function startWorker(
  env: Env,
  publishHandler?: PublishHandler,
): Promise<INestApplicationContext> {
  const app = await NestFactory.createApplicationContext(
    WorkerModule.register(env, publishHandler ? { publishHandler } : {}),
    { logger: false },
  );
  await app.init();
  return app;
}

/** Records when each target reaches the platform adapter. */
export class RecordingHandler implements PublishHandler {
  readonly calls: { target: PublishTarget; at: number }[] = [];

  constructor(private readonly outcome: PublishOutcomeState = 'published') {}

  publish(target: PublishTarget): Promise<PublishOutcomeState> {
    this.calls.push({ target, at: Date.now() });
    return Promise.resolve(this.outcome);
  }
}

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`condition not met within ${String(timeoutMs)} ms`);
}

export interface Fixture {
  orgId: string;
  workspaceId: string;
  socialAccountId: string;
}

export function createSeeder() {
  const db: Db = createDb({ connectionString: inject('databaseUrl') });

  return {
    db,
    async org(name: string): Promise<Fixture> {
      const org = await db.createOrganization({ name });
      return db.withTenant(org.id, async (tx) => {
        const workspace = await tx.workspace.create({ data: { organizationId: org.id, name } });
        const account = await tx.socialAccount.create({
          data: {
            organizationId: org.id,
            workspaceId: workspace.id,
            platform: 'instagram',
            externalAccountId: randomUUIDv7(),
            displayName: name,
          },
        });
        return { orgId: org.id, workspaceId: workspace.id, socialAccountId: account.id };
      });
    },
    async target(
      fixture: Fixture,
      state: PublicationState,
      scheduledAt: Date | null,
      extra: { queuedAt?: Date; attemptCount?: number; publishingStartedAt?: Date } = {},
    ): Promise<string> {
      return db.withTenant(fixture.orgId, async (tx) => {
        const post = await tx.post.create({
          data: { organizationId: fixture.orgId, workspaceId: fixture.workspaceId, body: 'hello' },
        });
        const target = await tx.publicationTarget.create({
          data: {
            organizationId: fixture.orgId,
            postId: post.id,
            socialAccountId: fixture.socialAccountId,
            state,
            scheduledAt,
            ...extra,
          },
        });
        return target.id;
      });
    },
    state(fixture: Fixture, targetId: string): Promise<PublicationState> {
      return db
        .withTenant(fixture.orgId, (tx) =>
          tx.publicationTarget.findUniqueOrThrow({ where: { id: targetId } }),
        )
        .then((t) => t.state);
    },
  };
}
