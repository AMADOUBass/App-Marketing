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
import {
  type AttemptData,
  PUBLISH_HANDLER,
  type PublishHandler,
  type PublishHooks,
  type PublishResult,
} from './publish-handler.js';

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
   * Runs one publish job, at most once per attempt (rule 6). Two independent guards, in one transaction:
   * 1. conditional transition queued -> publishing for this exact attempt (concurrent duplicates wait for
   *    the row lock, then match nothing);
   * 2. insert into publish_attempts, unique (target_id, attempt_no).
   * Anything else (duplicate or redelivered job, stale attempt, target of another organization hidden by
   * RLS) does nothing. A worker that dies mid-publish leaves the target 'publishing': the scheduler moves
   * it to unknown_outcome after the lease (never re-published blindly).
   */
  async process(job: PublishJobData): Promise<ProcessResult> {
    const log = this.logger.child({ targetId: job.targetId, attemptNo: job.attemptNo });

    const target = await this.db.withTenant(job.organizationId, async (tx) => {
      const { count } = await tx.publicationTarget.updateMany({
        where: { id: job.targetId, state: 'queued', attemptCount: job.attemptNo },
        data: { state: 'publishing', publishingStartedAt: new Date() },
      });
      if (count === 0) return null;
      await tx.publishAttempt.create({
        data: {
          organizationId: job.organizationId,
          targetId: job.targetId,
          attemptNo: job.attemptNo,
        },
      });
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

    const attemptWhere = { targetId: job.targetId, attemptNo: job.attemptNo };
    let progress: AttemptData = {};
    const hooks: PublishHooks = {
      recordProgress: async (data) => {
        progress = { ...progress, ...data };
        await this.db.withTenant(job.organizationId, (tx) =>
          tx.publishAttempt.updateMany({ where: attemptWhere, data: { response: progress } }),
        );
      },
    };

    let result: PublishResult;
    try {
      result = await this.handler.publish(
        {
          organizationId: job.organizationId,
          targetId: job.targetId,
          attemptNo: job.attemptNo,
          postId: target.postId,
          socialAccountId: target.socialAccountId,
          platform: target.socialAccount.platform,
        },
        hooks,
      );
    } catch (error) {
      // We cannot know whether the platform received it: reconcile before any new attempt (CLAUDE.md).
      log.error({ err: error }, 'publish handler threw; outcome unknown');
      result = { state: 'unknown_outcome', errorClass: 'unknown' };
    }
    const outcome: PublicationState = result.state;

    const stored = await this.db.withTenant(job.organizationId, async (tx) => {
      // The attempt keeps what the adapter reported, even if the lease expired meanwhile.
      await tx.publishAttempt.updateMany({
        where: attemptWhere,
        data: {
          finishedAt: new Date(),
          outcome,
          errorClass: result.errorClass ?? null,
          response: { ...progress, ...result.response },
        },
      });
      const { count } = await tx.publicationTarget.updateMany({
        where: { id: job.targetId, state: 'publishing', attemptCount: job.attemptNo },
        data: { state: outcome },
      });
      return count === 1;
    });
    if (!stored) {
      // The scheduler already moved it to unknown_outcome: reconciliation will use the attempt row.
      log.warn(
        { outcome },
        'lease expired before the adapter answered; target left in unknown_outcome',
      );
      return 'unknown_outcome';
    }
    log.info({ outcome }, 'publish job finished');
    return outcome;
  }
}
