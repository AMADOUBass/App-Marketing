import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Db, PublicationState } from '@ponctua/db';
import { DelayedError, type Job, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { RETRYABLE, retryDelaySeconds } from '../common/backoff.js';
import { recordTargetEvent } from '../common/outbox.js';
import type { RateLimiter } from '../common/rate-limiter.js';
import { PUBLISH_QUEUE, type PublishJobData } from '../common/queues.js';
import { DB, LOGGER, RATE_LIMITER, VALKEY } from '../common/tokens.js';
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
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
  ) {}

  onApplicationBootstrap(): void {
    this.worker = new Worker<PublishJobData, ProcessResult>(
      PUBLISH_QUEUE,
      (job, token) => this.run(job, token),
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
   * Rate limits first (ADR 013): over the platform's budget, the job is delayed in the queue for the
   * time the bucket needs, without starting the attempt (the target stays queued, same attempt number).
   */
  private async run(
    job: Job<PublishJobData, ProcessResult>,
    token?: string,
  ): Promise<ProcessResult> {
    if (this.env.RATE_LIMITS_ENABLED) {
      const waitMs = await this.admit(job.data);
      if (waitMs > 0) {
        await job.moveToDelayed(Date.now() + waitMs, token);
        throw new DelayedError();
      }
    }
    return this.process(job.data);
  }

  /** Takes a slot from the platform's buckets for this account. Returns how long to wait (0 = go). */
  async admit(job: PublishJobData): Promise<number> {
    const target = await this.db.withTenant(job.organizationId, (tx) =>
      tx.publicationTarget.findFirst({
        where: { id: job.targetId, state: 'queued', attemptCount: job.attemptNo },
        select: { socialAccountId: true, socialAccount: { select: { platform: true } } },
      }),
    );
    if (!target) return 0; // Not ours to run: process() will skip it.
    const decision = await this.limiter.take(target.socialAccount.platform, target.socialAccountId);
    if (decision.allowed) return 0;
    await this.db.withTenant(job.organizationId, (tx) =>
      tx.publicationTarget.updateMany({
        where: { id: job.targetId, state: 'queued', attemptCount: job.attemptNo },
        data: { statusReason: 'platform.rate_limited' },
      }),
    );
    this.logger.info(
      { targetId: job.targetId, waitMs: decision.retryAfterMs },
      'rate limited: publish job delayed',
    );
    return decision.retryAfterMs;
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
      result = { state: 'unknown_outcome', errorClass: 'unknown', reason: 'outcome.unknown' };
    }
    const outcome: PublicationState = result.state;
    const next = this.nextStep(result, job.attemptNo);

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
        data: {
          state: next.state,
          retryAt: next.retryAt,
          statusReason: next.reason,
          reconcileCount: 0,
        },
      });
      if (count === 1) {
        await recordTargetEvent(tx, {
          organizationId: job.organizationId,
          targetId: job.targetId,
          socialAccountId: target.socialAccountId,
          state: next.state,
          reason: next.reason,
        });
      }
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
    log.info({ outcome, state: next.state, reason: next.reason }, 'publish job finished');
    return next.state;
  }

  /**
   * What the target becomes (ADR 013). A transient or quota failure the platform marks as retryable
   * becomes 'retrying' with an exponential delay while attempts remain, then 'failed'. Anything else
   * keeps the handler's state; unknown_outcome is reconciled before any new attempt.
   */
  private nextStep(
    result: PublishResult,
    attemptNo: number,
  ): { state: PublicationState; retryAt: Date | null; reason: string | null } {
    const reason = result.reason ?? null;
    const retryable =
      result.state === 'failed' &&
      result.retryable === true &&
      RETRYABLE.includes(result.errorClass ?? 'unknown');
    if (!retryable) return { state: result.state, retryAt: null, reason };
    if (attemptNo >= this.env.PUBLISH_MAX_ATTEMPTS) {
      return { state: 'failed', retryAt: null, reason: 'retries.exhausted' };
    }
    const delay = retryDelaySeconds(this.env, attemptNo, result.errorClass);
    return { state: 'retrying', retryAt: new Date(Date.now() + delay * 1000), reason };
  }
}
