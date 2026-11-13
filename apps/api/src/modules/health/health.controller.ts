import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { Db } from '@ponctua/db';
import { DB } from '../../common/db.module.js';
import { Public } from '../../common/tenant.js';

export interface HealthStatus {
  status: 'ok';
}

@Public()
@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Liveness probe: the process is up and serving HTTP. */
  @Get()
  check(): HealthStatus {
    return { status: 'ok' };
  }

  /** Readiness probe: the process can reach its database. */
  @Get('ready')
  async ready(): Promise<HealthStatus> {
    try {
      await this.db.ping();
    } catch (error) {
      throw new ServiceUnavailableException('Database unavailable', { cause: error });
    }
    return { status: 'ok' };
  }
}
