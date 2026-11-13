import type { MeResponse } from '@ponctua/contracts';
import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  type RouterHistory,
  redirect,
} from '@tanstack/react-router';
import { AppLayout } from './components/app-layout';
import { AppShell } from './components/app-shell';
import { RouteError } from './components/route-error';
import { meQuery } from './lib/me';
import { useSession } from './lib/session';
import { AccountsPage, CONNECT_RESULTS, type ConnectResult } from './pages/accounts-page';
import { LoginPage } from './pages/login-page';
import { NewOrganizationPage } from './pages/new-organization-page';
import { OrganizationsPage } from './pages/organizations-page';
import { PostsPage } from './pages/posts-page';
import { SignUpPage } from './pages/signup-page';

interface RouterContext {
  queryClient: QueryClient;
}

/* eslint-disable @typescript-eslint/only-throw-error -- TanStack Router redirects are thrown */

/**
 * /me from the cache, or from the API on first use (null: not signed in). Cached answers are reused
 * on navigation; sign-in, sign-up, organization creation and sign-out refresh or drop them.
 */
const loadMe = (queryClient: QueryClient) => queryClient.query({ ...meQuery, staleTime: 'static' });

/** The selected organization, if the user (still) belongs to it. */
function currentOrganization(me: MeResponse) {
  const { organizationId } = useSession.getState();
  return me.organizations.find((organization) => organization.organizationId === organizationId);
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: AppShell,
  errorComponent: RouteError,
});

/** Sends each visitor to the right place: sign-in, onboarding, organization choice or the app. */
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: async ({ context }) => {
    const me = await loadMe(context.queryClient);
    if (!me) throw redirect({ to: '/login' });
    if (currentOrganization(me)) throw redirect({ to: '/posts' });

    const [only, ...others] = me.organizations;
    if (only && others.length === 0) {
      useSession.getState().selectOrganization(only.organizationId);
      throw redirect({ to: '/posts' });
    }
    throw redirect({ to: only ? '/organizations' : '/organizations/new' });
  },
});

/** Sign-in and sign-up: a signed-in visitor has nothing to do there. */
const guestOnly = async ({ context }: { context: RouterContext }) => {
  if (await loadMe(context.queryClient)) throw redirect({ to: '/' });
};

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  beforeLoad: guestOnly,
  component: LoginPage,
});

const signUpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/signup',
  beforeLoad: guestOnly,
  component: SignUpPage,
});

const requireUser = async ({ context }: { context: RouterContext }) => {
  if (!(await loadMe(context.queryClient))) throw redirect({ to: '/login' });
};

const organizationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/organizations',
  beforeLoad: requireUser,
  component: OrganizationsPage,
});

const newOrganizationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/organizations/new',
  beforeLoad: requireUser,
  component: NewOrganizationPage,
});

/** Signed-in area: a session and an organization the user belongs to. */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: async ({ context }) => {
    const me = await loadMe(context.queryClient);
    if (!me) throw redirect({ to: '/login' });
    if (!currentOrganization(me)) {
      // Removed from the organization, or none chosen yet: choose again.
      useSession.getState().clear();
      throw redirect({ to: '/' });
    }
  },
  component: AppLayout,
});

/* eslint-enable @typescript-eslint/only-throw-error */

const postsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/posts',
  component: PostsPage,
});

const accountsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/accounts',
  // ?instagram=<result> is set by the API after Meta's login dialog.
  validateSearch: (search: Record<string, unknown>): { instagram?: ConnectResult } =>
    (CONNECT_RESULTS as readonly unknown[]).includes(search.instagram)
      ? { instagram: search.instagram as ConnectResult }
      : {},
  component: function AccountsRoute() {
    const { instagram } = accountsRoute.useSearch();
    return <AccountsPage result={instagram} />;
  },
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  signUpRoute,
  organizationsRoute,
  newOrganizationRoute,
  appRoute.addChildren([postsRoute, accountsRoute]),
]);

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
