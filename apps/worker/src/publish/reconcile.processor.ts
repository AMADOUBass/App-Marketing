import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Db, PublicationState } from '@ponctua/db';
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { RETRYABLE, retryDelaySeconds } from '../common/backoff.js';
import { recordTargetEvent } from '../common/outbox.js';
import { RECONCILE_QUEUE, type ReconcileJobData } from '../common/queues.js';
import { DB, LOGGER, VALKEY } from '../common/tokens.js';
import { ENV, type Env } from '../config/env.js';
import {
  type AttemptData,
  PUBLISH_HANDLER,
  type PublishHandler,
  type ReconcileResult,
} from './publish-handler.js';

export type ReconcileProcessResult = 'skipped' | PublicationState;

interface NextStep {
  state: PublicationState;
  retryAt: Date | null;
  reason: string | null;
  reconcileCount: number;
}

/**
 * Settles unknown outcomes (ADR 013): never publishes, only asks the platform. Confirmed -> published;
 * certainly not published -> retried like a failed attempt (or failed); still unclear -> asked again
 * later with a growing delay, then handed to a human (needs_action) after RECONCILE_MAX_CHECKS.
 */
@Injectable()
export class ReconcileProcessor implements OnApplicationBootstrap, OnApplicationShutdown {
  private worker: Worker<ReconcileJobData, ReconcileProcessResult> | undefined;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(DB) private readonly db: Db,
    @Inject(VALKEY) private readonly valkey: Redis,
    @Inject(PUBLISH_HANDLER) private readonly handler: PublishHandler,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    this.worker = new Worker<ReconcileJobData, ReconcileProcessResult>(
      RECONCILE_QUEUE,
      (job) => this.process(job.data),
      {
        connection: this.valkey.duplicate({ maxRetriesPerRequest: null }),
        prefix: this.env.QUEUE_PREFIX,
        concurrency: this.env.PUBLISH_CONCURRENCY,
      },
    );
    this.worker.on('failed', (job, error) => {
      this.logger.error({ err: error, jobId: job?.id }, 'reconcile job failed');
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
  }

  async process(job: ReconcileJobData): Promise<ReconcileProcessResult> {
    const log = this.logger.child({ targetId: job.targetId, checkNo: job.checkNo });

    const found = await this.db.withTenant(job.organizationId, async (tx) => {
      const target = await tx.publicationTarget.findFirst({
        where: { id: job.targetId, state: 'unknown_outcome', reconcileCount: job.checkNo },
        select: {
          postId: true,
          socialAccountId: true,
          attemptCount: true,
          socialAccount: { select: { platform: true } },
        },
      });
      if (!target) return null;
      const attempt = await tx.publishAttempt.findFirst({
        where: { targetId: job.targetId, attemptNo: target.attemptCount },
        select: { response: true },
      });
      return { target, attempt: (attempt?.response ?? null) as AttemptData | null };
    });
    if (!found) {
      log.info('target no longer waiting for this check; skipping');
      return 'skipped';
    }

    let result: ReconcileResult;
    try {
      result = await this.handler.reconcile(
        {
          organizationId: job.organizationId,
          targetId: job.targetId,
          attemptNo: found.target.attemptCount,
          postId: found.target.postId,
          socialAccountId: found.target.socialAccountId,
          platform: found.target.socialAccount.platform,
        },
        found.attempt,
      );
    } catch (error) {
      log.warn({ err: error }, 'reconciliation failed; will ask again');
      result = { outcome: 'unknown' };
    }
    const next = this.nextStep(result, found.target.attemptCount, job.checkNo);

    const stored = await this.db.withTenant(job.organizationId, async (tx) => {
      const { count } = await tx.publicationTarget.updateMany({
        where: { id: job.targetId, state: 'unknown_outcome', reconcileCount: job.checkNo },
        data: {
          state: next.state,
          retryAt: next.retryAt,
          statusReason: next.reason,
          reconcileCount: next.reconcileCount,
        },
      });
      if (count === 0) return false;
      await tx.publishAttempt.updateMany({
        where: { targetId: job.targetId, attemptNo: found.target.attemptCount },
        data: {
          response: {
            ...(found.attempt ?? {}),
            ...(result.outcome === 'published' ? result.response : {}),
            reconciliation: result.outcome,
          },
        },
      });
      await recordTargetEvent(tx, {
        organizationId: job.organizationId,
        targetId: job.targetId,
        socialAccountId: found.target.socialAccountId,
        state: next.state,
        reason: next.reason,
      });
      return true;
    });
    if (!stored) return 'skipped';
    log.info({ outcome: result.outcome, state: next.state }, 'reconciliation done');
    return next.state;
  }

  private nextStep(result: ReconcileResult, attemptNo: number, checkNo: number): NextStep {
    switch (result.outcome) {
      case 'published':
        return {
          state: 'published',
          retryAt: null,
          reason: 'outcome.confirmed',
          reconcileCount: 0,
        };
      case 'not_published': {
        if (result.errorClass === 'auth') {
          return { state: 'needs_action', retryAt: null, reason: result.reason, reconcileCount: 0 };
        }
        if (!result.retryable || !RETRYABLE.includes(result.errorClass)) {
          return { state: 'failed', retryAt: null, reason: result.reason, reconcileCount: 0 };
        }
        if (attemptNo >= this.env.PUBLISH_MAX_ATTEMPTS) {
          return { state: 'failed', retryAt: null, reason: 'retries.exhausted', reconcileCount: 0 };
        }
        const delay = retryDelaySeconds(this.env, attemptNo, result.errorClass);
        return {
          state: 'retrying',
          retryAt: new Date(Date.now() + delay * 1000),
          reason: result.reason,
          reconcileCount: 0,
        };
      }
      case 'unknown': {
        const checks = checkNo + 1;
        if (checks >= this.env.RECONCILE_MAX_CHECKS) {
          // Never guess (rules 2 and 6): a person looks at the account and decides.
          return {
            state: 'needs_action',
            retryAt: null,
            reason: 'outcome.unconfirmed',
            reconcileCount: checks,
          };
        }
        const delay = retryDelaySeconds(this.env, checks, 'transient');
        return {
          state: 'unknown_outcome',
          retryAt: new Date(Date.now() + delay * 1000),
          reason: 'outcome.unknown',
          reconcileCount: checks,
        };
      }
    }
  }
}
