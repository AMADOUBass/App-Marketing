import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Db, DispatchItem, PrecheckItem, ReconcileItem } from '@ponctua/db';
import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import {
  type EventJobData,
  PRECHECK_QUEUE,
  type PrecheckJobData,
  precheckJobId,
  PUBLISH_QUEUE,
  type PublishJobData,
  publishJobId,
  RECONCILE_QUEUE,
  type ReconcileJobData,
  reconcileJobId,
} from '../common/queues.js';
import {
  DB,
  EVENTS_QUEUE_CLIENT,
  LOGGER,
  PRECHECK_QUEUE_CLIENT,
  PUBLISH_QUEUE_CLIENT,
  RECONCILE_QUEUE_CLIENT,
} from '../common/tokens.js';
import { ENV, type Env } from '../config/env.js';
import { LeaderLock } from './leader-lock.js';

export interface TickResult {
  leader: boolean;
  enqueued: number;
  reconciliations: number;
  events: number;
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
    @Inject(RECONCILE_QUEUE_CLIENT) private readonly reconcileQueue: Queue<ReconcileJobData>,
    @Inject(EVENTS_QUEUE_CLIENT) private readonly eventsQueue: Queue<EventJobData>,
    @Inject(PRECHECK_QUEUE_CLIENT) private readonly precheckQueue: Queue<PrecheckJobData>,
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
      if (!(await this.lock.acquireOrRenew())) {
        return { leader: false, enqueued: 0, reconciliations: 0, events: 0 };
      }

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

      // Retries whose time has come (ADR 013): a new attempt, with the exact remaining delay.
      const retries = await this.db.scheduler.claimDueRetries({
        horizonSeconds: this.env.SCHEDULER_HORIZON_SECONDS,
        limit: this.env.SCHEDULER_BATCH_SIZE,
      });
      // Unknown outcomes (including those just expired): ask the platform, never publish blindly.
      const reconciliations = await this.db.scheduler.claimDueReconciliations({
        leaseSeconds: this.env.RECONCILE_LEASE_SECONDS,
        limit: this.env.SCHEDULER_BATCH_SIZE,
      });

      // 15 minutes before: token, permissions, quota and media checked while there is time to fix them.
      const prechecks = await this.db.scheduler.claimDuePrechecks({
        leadSeconds: this.env.PRECHECK_LEAD_SECONDS,
        limit: this.env.SCHEDULER_BATCH_SIZE,
      });

      await this.enqueuePrechecks(prechecks);
      await this.enqueue([...due, ...stale, ...retries]);
      await this.enqueueReconciliations(reconciliations);
      const events = await this.relayOutbox();
      return {
        leader: true,
        enqueued: due.length + stale.length + retries.length,
        reconciliations: reconciliations.length,
        events,
      };
    } catch (error) {
      // A failed pass is retried on the next tick. Anything claimed but not enqueued comes back:
      // queued targets through requeueStale, reconciliations and outbox events after their lease.
      this.logger.error({ err: error }, 'scheduler tick failed');
      return { leader: true, enqueued: 0, reconciliations: 0, events: 0 };
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

  private async enqueuePrechecks(items: PrecheckItem[]): Promise<void> {
    if (items.length === 0) return;
    await this.precheckQueue.addBulk(
      items.map((item) => ({
        name: PRECHECK_QUEUE,
        data: {
          organizationId: item.organizationId,
          targetId: item.targetId,
          scheduledAt: item.scheduledAt.getTime(),
        },
        opts: {
          jobId: precheckJobId(item.targetId, item.scheduledAt.getTime()),
          removeOnComplete: true,
          removeOnFail: { age: 7 * 86_400 },
        },
      })),
    );
  }

  private async enqueueReconciliations(items: ReconcileItem[]): Promise<void> {
    if (items.length === 0) return;
    await this.reconcileQueue.addBulk(
      items.map((item) => ({
        name: RECONCILE_QUEUE,
        data: {
          organizationId: item.organizationId,
          targetId: item.targetId,
          checkNo: item.checkNo,
        },
        opts: {
          jobId: reconcileJobId(item.targetId, item.checkNo),
          // Removed at once: after the lease, the same check may be handed out again with this id.
          removeOnComplete: true,
          removeOnFail: { age: 7 * 86_400 },
        },
      })),
    );
    this.logger.info({ count: items.length }, 'unknown outcomes handed to reconciliation');
  }

  /**
   * Transactional outbox relay (ADR 013): leases undelivered events, hands them to the queue with the
   * event id as job id (a second hand-off after a crash is a no-op), then marks them delivered.
   */
  private async relayOutbox(): Promise<number> {
    const events = await this.db.outbox.claim({
      leaseSeconds: this.env.OUTBOX_LEASE_SECONDS,
      limit: this.env.SCHEDULER_BATCH_SIZE,
    });
    if (events.length === 0) return 0;
    await this.eventsQueue.addBulk(
      events.map((event) => ({
        name: event.type,
        data: {
          eventId: event.eventId,
          organizationId: event.organizationId,
          type: event.type,
          payload: event.payload,
        },
        opts: {
          jobId: event.eventId,
          removeOnComplete: { age: 86_400 },
          removeOnFail: { age: 7 * 86_400 },
        },
      })),
    );
    await this.db.outbox.complete(events.map((event) => event.eventId));
    return events.length;
  }
}
