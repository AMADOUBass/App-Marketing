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

const routeTree = rootRoute.addChildren([indexRoute, loginRoute, postsRoute]);

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
