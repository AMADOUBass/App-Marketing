import { z } from 'zod';
import { schedulingIssueSchema } from './scheduling.js';

/** RFC 9457 problem details, as returned by every API error (application/problem+json). */
export const problemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  /** Extension member (RFC 9457 section 3.2): what to fix, as codes the web app translates. */
  issues: z.array(schedulingIssueSchema).optional(),
});
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
