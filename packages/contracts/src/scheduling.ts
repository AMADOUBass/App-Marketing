import { z } from 'zod';

/** Header of create requests (CLAUDE.md section 8): a retried request with the same key runs once. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
/** Printable ASCII, 8 to 255 characters (a UUID fits). */
export const idempotencyKeySchema = z.string().regex(/^[\x21-\x7e]{8,255}$/);

/** CLAUDE.md section 5. */
export const publicationStateSchema = z.enum([
  'draft',
  'pending_approval',
  'scheduled',
  'queued',
  'publishing',
  'uploading',
  'remote_processing',
  'published',
  'retrying',
  'failed',
  'needs_action',
  'unknown_outcome',
  'reconciled',
  'cancelled',
]);
export type PublicationStateDto = z.infer<typeof publicationStateSchema>;

/** Not yet handed to the queue: the time can still change, or the target be cancelled. */
export const CANCELLABLE_STATES = ['draft', 'scheduled', 'retrying', 'needs_action'] as const;

/** How far ahead a post can be scheduled. */
export const MAX_SCHEDULE_AHEAD_DAYS = 365;

/** POST /posts/:id/schedule (Idempotency-Key required). */
export const schedulePostSchema = z.strictObject({
  socialAccountIds: z
    .array(z.uuid())
    .min(1)
    .max(20)
    .refine((ids) => new Set(ids).size === ids.length, 'each account once'),
  /** With an offset (e.g. 2026-11-20T14:30:00-05:00): the browser's time zone is explicit. */
  scheduledAt: z.iso.datetime({ offset: true }),
});
export type SchedulePostInput = z.infer<typeof schedulePostSchema>;

export const publicationTargetSchema = z.object({
  id: z.uuid(),
  postId: z.uuid(),
  socialAccountId: z.uuid(),
  state: publicationStateSchema,
  scheduledAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});
export type PublicationTargetDto = z.infer<typeof publicationTargetSchema>;

export const publicationTargetListSchema = z.object({ items: z.array(publicationTargetSchema) });
export type PublicationTargetList = z.infer<typeof publicationTargetListSchema>;

/** GET /publication-targets?postId=…&postId=… (the targets of the posts shown on a page). */
export const listTargetsQuerySchema = z.object({
  postId: z
    .union([z.uuid(), z.array(z.uuid()).min(1).max(100)])
    .transform((value) => (Array.isArray(value) ? value : [value])),
});
export type ListTargetsQuery = z.infer<typeof listTargetsQuerySchema>;

/**
 * Why a post cannot be scheduled on an account (422 problem, `issues` member). Codes come from the
 * capability registry checks (e.g. media.required) or the scheduling rules (e.g. account.not_connected).
 */
export const schedulingIssueSchema = z.object({
  socialAccountId: z.uuid().nullable(),
  code: z.string(),
});
export type SchedulingIssue = z.infer<typeof schedulingIssueSchema>;
