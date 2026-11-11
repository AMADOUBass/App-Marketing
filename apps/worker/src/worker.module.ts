import {
  type DynamicModule,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import { createDb, type Db } from '@app/db';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { type DestinationStream, type Logger, pino } from 'pino';
import { PUBLISH_QUEUE, type PublishJobData } from './common/queues.js';
import { DB, LOGGER, PUBLISH_QUEUE_CLIENT, VALKEY } from './common/tokens.js';
import { ENV, type Env } from './config/env.js';
import {
  NoAdapterPublishHandler,
  PUBLISH_HANDLER,
  type PublishHandler,
} from './publish/publish-handler.js';
import { PublishProcessor } from './publish/publish.processor.js';
import { LeaderLock } from './scheduler/leader-lock.js';
import { SchedulerService } from './scheduler/scheduler.service.js';

export interface WorkerModuleOptions {
  /** Platform adapters plug in here (0.9). Defaults to "needs_action": never fake a publication. */
  publishHandler?: PublishHandler;
  /** Overrides the log destination (tests). */
  logStream?: DestinationStream;
}

@Injectable()
class ConnectionsLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(VALKEY) private readonly valkey: Redis,
  ) {}

  // Runs after the scheduler and processor have stopped (they are destroyed first).
  async onApplicationShutdown(): Promise<void> {
    await this.db.disconnect();
    this.valkey.disconnect();
  }
}

@Injectable()
class QueueLifecycle implements OnApplicationShutdown {
  constructor(@Inject(PUBLISH_QUEUE_CLIENT) private readonly queue: Queue) {}

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
  }
}

function createLogger(env: Env, stream?: DestinationStream): Logger {
  const base = { level: env.LOG_LEVEL, base: { process: `worker:${env.PROCESS_ROLE}` } };
  if (stream) return pino(base, stream);
  if (env.LOG_PRETTY) return pino({ ...base, transport: { target: 'pino-pretty' } });
  return pino(base);
}

@Module({})
export class WorkerModule {
  static register(env: Env, options: WorkerModuleOptions = {}): DynamicModule {
    const runsScheduler = env.PROCESS_ROLE === 'scheduler' || env.PROCESS_ROLE === 'all';
    const runsPublish = env.PROCESS_ROLE === 'publish' || env.PROCESS_ROLE === 'all';

    const providers: Provider[] = [
      { provide: ENV, useValue: env },
      { provide: LOGGER, useValue: createLogger(env, options.logStream) },
      { provide: DB, useValue: createDb({ connectionString: env.DATABASE_URL }) },
      // BullMQ requires maxRetriesPerRequest: null on connections used by workers.
      {
        provide: VALKEY,
        useValue: new Redis(env.VALKEY_URL, { maxRetriesPerRequest: null, lazyConnect: false }),
      },
      ConnectionsLifecycle,
    ];

    if (runsScheduler) {
      providers.push(
        {
          provide: PUBLISH_QUEUE_CLIENT,
          inject: [VALKEY],
          useFactory: (valkey: Redis) =>
            new Queue<PublishJobData>(PUBLISH_QUEUE, {
              connection: valkey.duplicate(),
              prefix: env.QUEUE_PREFIX,
            }),
        },
        QueueLifecycle,
        {
          provide: LeaderLock,
          inject: [VALKEY],
          useFactory: (valkey: Redis) =>
            new LeaderLock(valkey, `${env.QUEUE_PREFIX}:scheduler:leader`, env.LEADER_LOCK_TTL_MS),
        },
        SchedulerService,
      );
    }

    if (runsPublish) {
      providers.push(
        {
          provide: PUBLISH_HANDLER,
          useValue: options.publishHandler ?? new NoAdapterPublishHandler(),
        },
        PublishProcessor,
      );
    }

    return { module: WorkerModule, providers };
  }
}
