import { Controller, Get } from '@nestjs/common';

export interface HealthStatus {
  status: 'ok';
}

@Controller({ path: 'health', version: '1' })
export class HealthController {
  /** Liveness probe: the process is up and serving HTTP. Dependency checks come with the database (0.4). */
  @Get()
  check(): HealthStatus {
    return { status: 'ok' };
  }
}
