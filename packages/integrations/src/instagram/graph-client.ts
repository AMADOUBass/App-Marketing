import type { Secret } from '@app/vault';
import { z } from 'zod';
import { instagramCapabilities } from '../capabilities/instagram.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const graphErrorSchema = z.object({
  error: z.object({
    message: z.string().optional(),
    type: z.string().optional(),
    code: z.number().optional(),
    error_subcode: z.number().optional(),
    fbtrace_id: z.string().optional(),
  }),
});

/**
 * Error answered by the Graph API. `message` is built from codes only: the platform's own message can
 * contain URLs (e.g. a signed media URL), so it is kept apart and never put in logs by default.
 */
export class GraphApiError extends Error {
  override readonly name = 'GraphApiError';

  constructor(
    readonly httpStatus: number,
    readonly code: number | null,
    readonly subcode: number | null,
    readonly type: string | null,
    readonly fbtraceId: string | null,
  ) {
    super(
      `Graph API error HTTP ${String(httpStatus)} code ${String(code)} subcode ${String(subcode)}`,
    );
  }
}

/** The request never got an HTTP answer (timeout, connection reset): the platform may or may not have acted. */
export class GraphNetworkError extends Error {
  override readonly name = 'GraphNetworkError';
}

export interface GraphClientOptions {
  fetch?: FetchLike;
  /** Per-request timeout. */
  timeoutMs?: number;
}

export interface GraphRequest {
  method: 'GET' | 'POST';
  /** Path after the version, e.g. `/17841…/media`. */
  path: string;
  params?: Record<string, string>;
  accessToken?: Secret;
}

export function createGraphClient(options: GraphClientOptions = {}) {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const base = `${instagramCapabilities.graphHost.value}/${instagramCapabilities.graphApiVersion.value}`;

  return async function request<T>(req: GraphRequest, schema: z.ZodType<T>): Promise<T> {
    const url = new URL(`${base}${req.path}`);
    const headers: Record<string, string> = { accept: 'application/json' };
    // Bearer header, never `access_token=` in the URL: URLs end up in proxies and logs.
    if (req.accessToken) headers.authorization = `Bearer ${req.accessToken.reveal()}`;

    let body: URLSearchParams | undefined;
    if (req.method === 'GET') {
      for (const [key, value] of Object.entries(req.params ?? {})) url.searchParams.set(key, value);
    } else {
      body = new URLSearchParams(req.params);
    }

    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        method: req.method,
        headers,
        ...(body ? { body } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // Do not chain the original error: it can embed the request URL.
      throw new GraphNetworkError(`${req.method} ${req.path.split('?')[0] ?? ''} got no response`);
    }

    const json: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const parsed = graphErrorSchema.safeParse(json);
      const error = parsed.success ? parsed.data.error : null;
      throw new GraphApiError(
        response.status,
        error?.code ?? null,
        error?.error_subcode ?? null,
        error?.type ?? null,
        error?.fbtrace_id ?? null,
      );
    }
    return schema.parse(json);
  };
}

export type GraphRequestFn = ReturnType<typeof createGraphClient>;
