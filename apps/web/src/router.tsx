import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  type RouterHistory,
  redirect,
} from '@tanstack/react-router';
import { AppShell } from './components/app-shell';
import { useSession } from './lib/session';
import { AccountsPage, CONNECT_RESULTS, type ConnectResult } from './pages/accounts-page';
import { LoginPage } from './pages/login-page';
import { PostsPage } from './pages/posts-page';

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: AppShell,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirects are thrown
    throw redirect({ to: useSession.getState().organizationId ? '/posts' : '/login' });
  },
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
});

const postsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/posts',
  beforeLoad: () => {
    if (!useSession.getState().organizationId) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirects are thrown
      throw redirect({ to: '/login' });
    }
  },
  component: PostsPage,
});

const requireOrganization = () => {
  if (!useSession.getState().organizationId) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirects are thrown
    throw redirect({ to: '/login' });
  }
};

const accountsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/accounts',
  // ?instagram=<result> is set by the API after Meta's login dialog.
  validateSearch: (search: Record<string, unknown>): { instagram?: ConnectResult } =>
    (CONNECT_RESULTS as readonly unknown[]).includes(search.instagram)
      ? { instagram: search.instagram as ConnectResult }
      : {},
  beforeLoad: requireOrganization,
  component: function AccountsRoute() {
    const { instagram } = accountsRoute.useSearch();
    return <AccountsPage result={instagram} />;
  },
});

const routeTree = rootRoute.addChildren([indexRoute, loginRoute, postsRoute, accountsRoute]);

export function createAppRouter(queryClient: QueryClient, history?: RouterHistory) {
  return createRouter({
    routeTree,
    context: { queryClient },
    ...(history ? { history } : {}),
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
