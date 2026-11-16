import { Module } from '@nestjs/common';
import { ContentModule } from '../content/content.module.js';
import { SchedulingController } from './scheduling.controller.js';
import { SchedulingService } from './scheduling.service.js';

/** Publication targets: schedule, cancel, read states (CLAUDE.md section 4, ADR 012). */
@Module({
  imports: [ContentModule],
  controllers: [SchedulingController],
  providers: [SchedulingService],
})
export class SchedulingModule {}
