import type { MeResponse, UserOrganization } from '@ponctua/contracts';
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { App } from '../src/app';
import { i18n } from '../src/i18n';
import { useSession } from '../src/lib/session';

export const ORG_ID = '0195f000-0000-7000-8000-00000000000a';
export const OTHER_ORG_ID = '0195f000-0000-7000-8000-00000000000b';

export const ORG_A: UserOrganization = {
  organizationId: ORG_ID,
  name: 'Agence Démo A',
  role: 'owner',
};
export const ORG_B: UserOrganization = {
  organizationId: OTHER_ORG_ID,
  name: 'Agence Démo B',
  role: 'member',
};

/** The /me answer for a signed-in user. */
export function me(organizations: UserOrganization[] = [ORG_A]): MeResponse {
  return {
    user: {
      id: '0195f000-0000-7000-8000-000000000c01',
      name: 'Amélie Tremblay',
      email: 'amelie@agence.ca',
    },
    organizations,
  };
}

const problem = (status: number, title: string) => ({ type: 'about:blank', title, status });

export const SIGNED_OUT: Reply = { status: 401, body: problem(401, 'Unauthorized') };

/** Better Auth error answer ({ code, message }). */
export const authError = (status: number, code: string): Reply => ({
  status,
  body: { code, message: code },
});

beforeEach(async () => {
  await i18n.changeLanguage('fr');
  useSession.getState().clear();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

export function renderApp(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const history = createMemoryHistory({ initialEntries: [path] });
  return { ...render(<App queryClient={queryClient} history={history} />), history, queryClient };
}

export function post(body: string, index = 0) {
  const date = new Date(Date.UTC(2026, 10, 1 + index, 14, 30)).toISOString();
  return {
    id: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    body,
    createdAt: date,
    updatedAt: date,
  };
}

export interface Reply {
  status?: number;
  body?: unknown;
}

export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  headers: Headers;
  credentials: RequestCredentials | undefined;
  body: unknown;
}

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

/**
 * Stubs fetch by route. Keys are "/api/v1/posts" (any method) or "POST /api/auth/sign-in/email",
 * matched on the path (query ignored). A list of replies is served in order, the last one repeats.
 * An unknown route rejects, so a forgotten mock fails the test instead of passing silently.
 */
export function mockApi(routes: Record<string, Reply | Reply[]>) {
  const requests: RecordedRequest[] = [];
  const served = new Map<string, number>();

  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      const path = new URL(url, 'http://localhost').pathname;
      const method = init?.method ?? 'GET';
      requests.push({
        method,
        url,
        path,
        headers: new Headers(init?.headers),
        credentials: init?.credentials,
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      });

      const key = [`${method} ${path}`, path].find((candidate) => candidate in routes);
      const route = key ? routes[key] : undefined;
      if (!key || !route) return Promise.reject(new Error(`Unmocked request: ${method} ${url}`));

      const replies = Array.isArray(route) ? route : [route];
      const count = served.get(key) ?? 0;
      served.set(key, count + 1);
      const reply = replies[Math.min(count, replies.length - 1)] ?? {};
      const status = reply.status ?? 200;
      return Promise.resolve(
        new Response(JSON.stringify(reply.body ?? null), {
          status,
          headers: {
            'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
          },
        }),
      );
    }),
  );

  return {
    requests,
    to: (path: string) => requests.filter((request) => request.path === path),
  };
}
