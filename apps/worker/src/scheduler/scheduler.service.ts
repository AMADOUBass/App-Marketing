import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Db, DispatchItem } from '@app/db';
import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import { PUBLISH_QUEUE, type PublishJobData, publishJobId } from '../common/queues.js';
import { DB, LOGGER, PUBLISH_QUEUE_CLIENT } from '../common/tokens.js';
import { ENV, type Env } from '../config/env.js';
import { LeaderLock } from './leader-lock.js';

export interface TickResult {
  leader: boolean;
  enqueued: number;
}

/**
 * Every SCHEDULER_TICK_MS, the leader hands targets due within the horizon to the queue with their exact
 * remaining delay. PostgreSQL stays the source of truth; Valkey only executes.
 */
@Injectable()
export class SchedulerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<TickResult> | undefined;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(DB) private readonly db: Db,
    @Inject(PUBLISH_QUEUE_CLIENT) private readonly queue: Queue<PublishJobData>,
    private readonly lock: LeaderLock,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), this.env.SCHEDULER_TICK_MS);
    void this.tick();
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
    await this.lock.release();
  }

  /** One scheduling pass. Never runs twice at the same time in one process. */
  tick(): Promise<TickResult> {
    this.running ??= this.runTick().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async runTick(): Promise<TickResult> {
    try {
      if (!(await this.lock.acquireOrRenew())) return { leader: false, enqueued: 0 };

      const due = await this.db.scheduler.claimDue({
        horizonSeconds: this.env.SCHEDULER_HORIZON_SECONDS,
        limit: this.env.SCHEDULER_BATCH_SIZE,
      });
      const stale = await this.db.scheduler.requeueStale({
        graceSeconds: this.env.SCHEDULER_RECOVERY_GRACE_SECONDS,
        limit: this.env.SCHEDULER_BATCH_SIZE,
      });
      if (stale.length > 0) {
        this.logger.warn({ count: stale.length }, 'requeueing targets whose job was probably lost');
      }
      // Rule 6: nothing stays in flight forever. Never re-queued: reconciliation decides.
      const expired = await this.db.scheduler.expireStuck({
        leaseSeconds: this.env.PUBLISH_LEASE_SECONDS,
        limit: this.env.SCHEDULER_BATCH_SIZE,
      });
      for (const item of expired) {
        this.logger.warn(
          { targetId: item.targetId, attemptNo: item.attemptNo },
          'publish lease expired (worker died?); target moved to unknown_outcome',
        );
      }

      await this.enqueue([...due, ...stale]);
      return { leader: true, enqueued: due.length + stale.length };
    } catch (error) {
      // A failed pass is retried on the next tick; claimed-but-not-enqueued targets are recovered later.
      this.logger.error({ err: error }, 'scheduler tick failed');
      return { leader: true, enqueued: 0 };
    }
  }

  private async enqueue(items: DispatchItem[]): Promise<void> {
    if (items.length === 0) return;
    const now = Date.now();
    await this.queue.addBulk(
      items.map((item) => ({
        name: PUBLISH_QUEUE,
        data: {
          organizationId: item.organizationId,
          targetId: item.targetId,
          attemptNo: item.attemptNo,
        },
        opts: {
          jobId: publishJobId(item.targetId, item.attemptNo),
          delay: Math.max(0, item.scheduledAt.getTime() - now),
          removeOnComplete: { age: 86_400 },
          removeOnFail: { age: 7 * 86_400 },
        },
      })),
    );
    this.logger.info({ count: items.length }, 'targets handed to the publish queue');
  }
}
