import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Db } from '@ponctua/db';
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { recordTargetEvent } from '../common/outbox.js';
import { PRECHECK_QUEUE, type PrecheckJobData } from '../common/queues.js';
import { DB, LOGGER, VALKEY } from '../common/tokens.js';
import { ENV, type Env } from '../config/env.js';
import { PUBLISH_HANDLER, type PrecheckResult, type PublishHandler } from './publish-handler.js';

export type PrecheckProcessResult = 'skipped' | PrecheckResult['outcome'];

/**
 * Runs the 15-minute pre-check (CLAUDE.md section 5, ADR 013). A blocking problem (no token, missing
 * permission, invalid media) moves the target to needs_action now, while someone can still fix it,
 * instead of failing at the scheduled time. A warning keeps it scheduled with a reason.
 */
@Injectable()
export class PrecheckProcessor implements OnApplicationBootstrap, OnApplicationShutdown {
  private worker: Worker<PrecheckJobData, PrecheckProcessResult> | undefined;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(DB) private readonly db: Db,
    @Inject(VALKEY) private readonly valkey: Redis,
    @Inject(PUBLISH_HANDLER) private readonly handler: PublishHandler,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    this.worker = new Worker<PrecheckJobData, PrecheckProcessResult>(
      PRECHECK_QUEUE,
      (job) => this.process(job.data),
      {
        connection: this.valkey.duplicate({ maxRetriesPerRequest: null }),
        prefix: this.env.QUEUE_PREFIX,
        concurrency: this.env.PUBLISH_CONCURRENCY,
      },
    );
    this.worker.on('failed', (job, error) => {
      this.logger.error({ err: error, jobId: job?.id }, 'pre-check job failed');
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
  }

  async process(job: PrecheckJobData): Promise<PrecheckProcessResult> {
    const scheduledAt = new Date(job.scheduledAt);
    const target = await this.db.withTenant(job.organizationId, (tx) =>
      tx.publicationTarget.findFirst({
        where: { id: job.targetId, state: 'scheduled', scheduledAt },
        select: {
          postId: true,
          socialAccountId: true,
          attemptCount: true,
          socialAccount: { select: { platform: true } },
        },
      }),
    );
    if (!target) return 'skipped'; // cancelled, rescheduled or already gone

    let result: PrecheckResult;
    try {
      result = await this.handler.precheck({
        organizationId: job.organizationId,
        targetId: job.targetId,
        attemptNo: target.attemptCount,
        postId: target.postId,
        socialAccountId: target.socialAccountId,
        platform: target.socialAccount.platform,
      });
    } catch (error) {
      this.logger.warn({ err: error, targetId: job.targetId }, 'pre-check could not run');
      result = { outcome: 'unknown' };
    }
    if (result.outcome === 'ok' || result.outcome === 'unknown') return result.outcome;

    const blocked = result.outcome === 'blocked';
    const stored = await this.db.withTenant(job.organizationId, async (tx) => {
      const { count } = await tx.publicationTarget.updateMany({
        where: { id: job.targetId, state: 'scheduled', scheduledAt },
        data: blocked
          ? { state: 'needs_action', statusReason: result.reason }
          : { statusReason: result.reason },
      });
      if (count === 1 && blocked) {
        await recordTargetEvent(tx, {
          organizationId: job.organizationId,
          targetId: job.targetId,
          socialAccountId: target.socialAccountId,
          state: 'needs_action',
          reason: result.reason,
        });
      }
      return count === 1;
    });
    if (!stored) return 'skipped';
    this.logger.info(
      { targetId: job.targetId, outcome: result.outcome, reason: result.reason },
      'pre-check found a problem',
    );
    return result.outcome;
  }
}
