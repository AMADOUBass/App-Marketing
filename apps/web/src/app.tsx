import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, type RouterHistory } from '@tanstack/react-router';
import { useState } from 'react';
import { createAppRouter } from './router';
import './i18n';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
  });
}

export function App({
  queryClient,
  history,
}: {
  queryClient?: QueryClient;
  history?: RouterHistory;
}) {
  const [client] = useState(() => queryClient ?? createQueryClient());
  const [router] = useState(() => createAppRouter(client, history));

  return (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
