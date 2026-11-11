import { z } from 'zod';

/** RFC 9457 problem details, as returned by every API error (application/problem+json). */
export const problemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
});
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
