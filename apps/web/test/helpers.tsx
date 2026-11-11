import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { App } from '../src/app';
import { i18n } from '../src/i18n';
import { useSession } from '../src/lib/session';

export const ORG_ID = '0195f000-0000-7000-8000-00000000000a';

beforeEach(async () => {
  await i18n.changeLanguage('fr');
  useSession.getState().signOut();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

export function renderApp(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const history = createMemoryHistory({ initialEntries: [path] });
  return { ...render(<App queryClient={queryClient} history={history} />), history };
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

interface Reply {
  status?: number;
  body: unknown;
}

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

/** Stubs fetch with one reply per call (the last one repeats) and records the requests. */
export function mockApi(...replies: Reply[]) {
  const requests: { url: string; headers: Headers }[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: urlOf(input), headers: new Headers(init?.headers) });
    const reply = replies[Math.min(requests.length - 1, replies.length - 1)] ?? { body: null };
    const status = reply.status ?? 200;
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status,
        headers: {
          'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
        },
      }),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return requests;
}
