import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Db, PublicationState } from '@app/db';
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { PUBLISH_QUEUE, type PublishJobData } from '../common/queues.js';
import { DB, LOGGER, VALKEY } from '../common/tokens.js';
import { ENV, type Env } from '../config/env.js';
import { PUBLISH_HANDLER, type PublishHandler } from './publish-handler.js';

export type ProcessResult = 'skipped' | PublicationState;

@Injectable()
export class PublishProcessor implements OnApplicationBootstrap, OnApplicationShutdown {
  private worker: Worker<PublishJobData, ProcessResult> | undefined;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(DB) private readonly db: Db,
    @Inject(VALKEY) private readonly valkey: Redis,
    @Inject(PUBLISH_HANDLER) private readonly handler: PublishHandler,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    this.worker = new Worker<PublishJobData, ProcessResult>(
      PUBLISH_QUEUE,
      (job) => this.process(job.data),
      {
        connection: this.valkey.duplicate({ maxRetriesPerRequest: null }),
        prefix: this.env.QUEUE_PREFIX,
        concurrency: this.env.PUBLISH_CONCURRENCY,
      },
    );
    this.worker.on('failed', (job, error) => {
      this.logger.error({ err: error, jobId: job?.id }, 'publish job failed');
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
  }

  /**
   * Runs one publish job. The target must still be 'queued' for this exact attempt: duplicates, stale
   * attempts and jobs pointing at another organization's target (hidden by RLS) do nothing.
   */
  async process(job: PublishJobData): Promise<ProcessResult> {
    const log = this.logger.child({ targetId: job.targetId, attemptNo: job.attemptNo });

    const target = await this.db.withTenant(job.organizationId, async (tx) => {
      const { count } = await tx.publicationTarget.updateMany({
        where: { id: job.targetId, state: 'queued', attemptCount: job.attemptNo },
        data: { state: 'publishing' },
      });
      if (count === 0) return null;
      return tx.publicationTarget.findUniqueOrThrow({
        where: { id: job.targetId },
        select: {
          postId: true,
          socialAccountId: true,
          socialAccount: { select: { platform: true } },
        },
      });
    });
    if (!target) {
      log.info('target not queued for this attempt; skipping');
      return 'skipped';
    }

    let outcome: PublicationState;
    try {
      outcome = await this.handler.publish({
        organizationId: job.organizationId,
        targetId: job.targetId,
        attemptNo: job.attemptNo,
        postId: target.postId,
        socialAccountId: target.socialAccountId,
        platform: target.socialAccount.platform,
      });
    } catch (error) {
      // We cannot know whether the platform received it: reconcile before any new attempt (CLAUDE.md).
      log.error({ err: error }, 'publish handler threw; outcome unknown');
      outcome = 'unknown_outcome';
    }

    await this.db.withTenant(job.organizationId, (tx) =>
      tx.publicationTarget.updateMany({
        where: { id: job.targetId, state: 'publishing' },
        data: { state: outcome },
      }),
    );
    log.info({ outcome }, 'publish job finished');
    return outcome;
  }
}
