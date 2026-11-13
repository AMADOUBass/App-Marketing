import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, type RouterHistory } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { ApiError } from './lib/api';
import { forgetSession } from './lib/me';
import { createAppRouter } from './router';
import './i18n';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
  });
}

const isUnauthorized = (error: unknown) => error instanceof ApiError && error.status === 401;

export function App({
  queryClient,
  history,
}: {
  queryClient?: QueryClient;
  history?: RouterHistory;
}) {
  const [client] = useState(() => queryClient ?? createQueryClient());
  const [router] = useState(() => createAppRouter(client, history));

  // Session expired or revoked (any API call answers 401): forget everything and sign in again.
  useEffect(() => {
    const onError = (error: unknown) => {
      if (!isUnauthorized(error)) return;
      queueMicrotask(() => {
        forgetSession(client);
        void router.navigate({ to: '/login' });
      });
    };
    const unsubscribeQueries = client.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'error') onError(event.action.error);
    });
    const unsubscribeMutations = client.getMutationCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'error') onError(event.action.error);
    });
    return () => {
      unsubscribeQueries();
      unsubscribeMutations();
    };
  }, [client, router]);

  return (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
