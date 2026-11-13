import type { FetchLike } from '../src/index.js';

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: URLSearchParams | null;
}

type Reply = { status?: number; json: unknown } | { networkError: true };

interface Route {
  method: string;
  path: RegExp;
  replies: Reply[];
}

/**
 * Minimal in-memory Graph API: routes answer in order (the last reply repeats). Records every request so
 * tests can assert on parameters and on what never leaves the process (tokens in URLs).
 */
export function createFakeGraph() {
  const routes: Route[] = [];
  const requests: RecordedRequest[] = [];

  const fetch: FetchLike = (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = init?.body instanceof URLSearchParams ? init.body : null;
    requests.push({ method, url, headers, body });

    const route = routes.find((r) => r.method === method && r.path.test(url.pathname));
    if (!route) return Promise.reject(new Error(`unexpected ${method} ${url.pathname}`));
    const reply = route.replies.length > 1 ? route.replies.shift() : route.replies[0];
    if (!reply || 'networkError' in reply) {
      return Promise.reject(new TypeError(`fetch failed for ${url.toString()}`));
    }
    return Promise.resolve(
      new Response(JSON.stringify(reply.json), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };

  return {
    fetch,
    requests,
    on(method: 'GET' | 'POST', path: RegExp, ...replies: Reply[]) {
      routes.push({ method, path, replies });
      return this;
    },
    calls(method: string, path: RegExp) {
      return requests.filter((r) => r.method === method && path.test(r.url.pathname));
    },
  };
}
