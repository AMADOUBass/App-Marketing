import { type ProblemDetails, problemDetailsSchema } from '@ponctua/contracts';
import type { z } from 'zod';

/** Organization the request acts for. The API checks the signed-in user is a member (403 otherwise). */
export const ORGANIZATION_HEADER = 'x-organization-id';

export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    readonly status: number,
    readonly problem: ProblemDetails | null,
  ) {
    super(problem?.title ?? `HTTP ${String(status)}`);
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH';
  /** Omitted for routes that act for the user, not an organization (/me, creating an organization). */
  organizationId?: string | null;
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * Calls /api/v1{path} with the session cookie. The response is validated against the shared
 * contract, so a backend change that breaks the shape fails loudly here instead of rendering garbage.
 */
export async function apiRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  { method = 'GET', organizationId, body, signal }: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (organizationId) headers[ORGANIZATION_HEADER] = organizationId;
  if (body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`/api/v1${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    const problem: unknown = await response.json().catch(() => null);
    const parsed = problemDetailsSchema.safeParse(problem);
    throw new ApiError(response.status, parsed.success ? parsed.data : null);
  }

  return schema.parse(await response.json());
}

/** GET for the current organization. */
export function apiGet<T>(
  path: string,
  schema: z.ZodType<T>,
  organizationId: string,
  signal?: AbortSignal,
): Promise<T> {
  return apiRequest(path, schema, { organizationId, ...(signal ? { signal } : {}) });
}
