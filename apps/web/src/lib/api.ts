import { type ProblemDetails, problemDetailsSchema } from '@app/contracts';
import type { z } from 'zod';

/** Temporary tenant header (ADR 003), replaced by the session cookie with Better Auth. */
export const DEV_TENANT_HEADER = 'x-dev-organization-id';

export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    readonly status: number,
    readonly problem: ProblemDetails | null,
  ) {
    super(problem?.title ?? `HTTP ${String(status)}`);
  }
}

/**
 * GET /api/v1{path} for the current organization. The response is validated against the shared
 * contract, so a backend change that breaks the shape fails loudly here instead of rendering garbage.
 */
export async function apiGet<T>(
  path: string,
  schema: z.ZodType<T>,
  organizationId: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    headers: { accept: 'application/json', [DEV_TENANT_HEADER]: organizationId },
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const problem = problemDetailsSchema.safeParse(body);
    throw new ApiError(response.status, problem.success ? problem.data : null);
  }

  return schema.parse(await response.json());
}
