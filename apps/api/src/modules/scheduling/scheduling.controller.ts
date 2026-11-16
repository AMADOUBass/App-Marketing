import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import {
  type ListTargetsQuery,
  listTargetsQuerySchema,
  postIdSchema,
  type PublicationTargetDto,
  type PublicationTargetList,
  type SchedulePostInput,
  schedulePostSchema,
} from '@ponctua/contracts';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { IdempotencyKey, sendIdempotent } from '../../common/idempotency.js';
import { OrganizationId } from '../../common/tenant.js';
import { SchedulingService } from './scheduling.service.js';

const targetIdSchema = z.uuid();

@Controller({ version: '1' })
export class SchedulingController {
  constructor(private readonly scheduling: SchedulingService) {}

  /** 201 with the targets; the same Idempotency-Key replays the answer. 422 lists what to fix. */
  @Post('posts/:id/schedule')
  async schedule(
    @OrganizationId() organizationId: string,
    @Param('id', { schema: postIdSchema }) postId: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body({ schema: schedulePostSchema }) input: SchedulePostInput,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<PublicationTargetList> {
    return sendIdempotent(
      reply,
      await this.scheduling.schedule(organizationId, postId, input, idempotencyKey),
    );
  }

  @Post('publication-targets/:id/cancel')
  @HttpCode(200)
  cancel(
    @OrganizationId() organizationId: string,
    @Param('id', { schema: targetIdSchema }) targetId: string,
  ): Promise<PublicationTargetDto> {
    return this.scheduling.cancel(organizationId, targetId);
  }

  @Get('publication-targets')
  list(
    @OrganizationId() organizationId: string,
    @Query({ schema: listTargetsQuerySchema }) query: ListTargetsQuery,
  ): Promise<PublicationTargetList> {
    return this.scheduling.list(organizationId, query.postId);
  }
}
