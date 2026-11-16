import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { EVENTS_QUEUE, type EventJobData } from '../common/queues.js';
import { LOGGER, VALKEY } from '../common/tokens.js';
import { ENV, type Env } from '../config/env.js';

/**
 * Consumes outbox events (ADR 013). For now it records them in the logs (type and identifiers only);
 * notifications and live updates (SSE) will subscribe here.
 */
@Injectable()
export class EventsProcessor implements OnApplicationBootstrap, OnApplicationShutdown {
  private worker: Worker<EventJobData> | undefined;
  /** Events seen by this process (tests read it). */
  readonly handled: EventJobData[] = [];

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(VALKEY) private readonly valkey: Redis,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    this.worker = new Worker<EventJobData>(
      EVENTS_QUEUE,
      (job) => {
        this.handled.push(job.data);
        const payload = job.data.payload as { targetId?: unknown } | null;
        this.logger.info(
          {
            eventId: job.data.eventId,
            type: job.data.type,
            organizationId: job.data.organizationId,
            targetId: typeof payload?.targetId === 'string' ? payload.targetId : undefined,
          },
          'outbox event',
        );
        return Promise.resolve();
      },
      {
        connection: this.valkey.duplicate({ maxRetriesPerRequest: null }),
        prefix: this.env.QUEUE_PREFIX,
      },
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
  }
}
