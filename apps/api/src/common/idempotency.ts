import { createHash } from 'node:crypto';
import {
  BadRequestException,
  createParamDecorator,
  type ExecutionContext,
  UnprocessableEntityException,
} from '@nestjs/common';
import { IDEMPOTENCY_KEY_HEADER, idempotencyKeySchema } from '@ponctua/contracts';
import type { IdempotentRequest, IdempotentResult } from '@ponctua/db';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** How long an answer is kept for replays (a client retrying after a network error). */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/** Header set on a replayed answer, so a client (and the logs) can tell. */
export const IDEMPOTENT_REPLAYED_HEADER = 'idempotent-replayed';

/** The Idempotency-Key header, required on create requests (CLAUDE.md section 8): 400 otherwise. */
export const IdempotencyKey = createParamDecorator((_: unknown, context: ExecutionContext) => {
  const value = context.switchToHttp().getRequest<FastifyRequest>().headers[IDEMPOTENCY_KEY_HEADER];
  const parsed = idempotencyKeySchema.safeParse(value);
  if (!parsed.success) {
    throw new BadRequestException(
      `${IDEMPOTENCY_KEY_HEADER} header required (8 to 255 printable characters, e.g. a UUID)`,
    );
  }
  return parsed.data;
});

/** Same key + same operation + same input = same request. Input keys follow the schema's order. */
export function idempotentRequest(
  key: string,
  operation: string,
  input: unknown,
): IdempotentRequest {
  const requestHash = createHash('sha256')
    .update(operation)
    .update('\n')
    .update(JSON.stringify(input))
    .digest('hex');
  return { key, operation, requestHash, ttlSeconds: IDEMPOTENCY_TTL_SECONDS };
}

/** Sends the stored or fresh answer; a key reused for another request is refused (422). */
export function sendIdempotent<T>(reply: FastifyReply, result: IdempotentResult<T>): T {
  if (result.outcome === 'mismatch') {
    throw new UnprocessableEntityException(
      `${IDEMPOTENCY_KEY_HEADER} already used for a different request`,
    );
  }
  void reply.status(result.status);
  if (result.outcome === 'replayed') void reply.header(IDEMPOTENT_REPLAYED_HEADER, 'true');
  return result.body as T;
}
