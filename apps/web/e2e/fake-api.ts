import type { Page, Route } from '@playwright/test';

interface FakeOrganization {
  organizationId: string;
  name: string;
  role: 'owner' | 'admin' | 'member';
  posts: string[];
}

interface FakeUser {
  id: string;
  name: string;
  email: string;
  password: string;
  /** Address confirmed through the emailed link (required before signing in, ADR 009). */
  verified?: boolean;
  organizations: FakeOrganization[];
}

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({
    status,
    contentType: status >= 400 ? 'application/problem+json' : 'application/json',
    body: JSON.stringify(body),
  });

const problem = (status: number, title: string) => ({ type: 'about:blank', title, status });

let ids = 0;
const nextId = () => `0195f000-0000-7000-8000-${String(++ids).padStart(12, '0')}`;

/**
 * In-browser stand-in for the API (auth + /api/v1), with the same rules as the real one: a session,
 * membership checked on every organization request (403 otherwise), Better Auth error codes.
 * The real server behaviour is covered by apps/api/test/auth.test.ts.
 */
export async function installFakeApi(page: Page, users: Omit<FakeUser, 'id'>[] = []) {
  const accounts: FakeUser[] = users.map((user) => ({ ...user, id: nextId() }));
  let session: FakeUser | null = null;
  const organizationHeaders: string[] = [];
  /** Reset links "emailed" so far: token -> account. */
  const resetTokens = new Map<string, FakeUser>();

  await page.route('**/api/auth/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = (route.request().postDataJSON() ?? {}) as Record<string, string>;

    if (path === '/api/auth/sign-in/email') {
      const user = accounts.find((u) => u.email === body.email && u.password === body.password);
      if (!user) return json(route, 401, { code: 'INVALID_EMAIL_OR_PASSWORD' });
      if (user.verified === false) return json(route, 403, { code: 'EMAIL_NOT_VERIFIED' });
      session = user;
      return json(route, 200, { user: { id: user.id } });
    }
    if (path === '/api/auth/sign-up/email') {
      // Like the real API: same answer for a taken address, and no session before confirmation.
      if (!accounts.some((u) => u.email === body.email)) {
        accounts.push({
          id: nextId(),
          name: body.name ?? '',
          email: body.email ?? '',
          password: body.password ?? '',
          verified: false,
          organizations: [],
        });
      }
      return json(route, 200, { token: null, user: { id: nextId() } });
    }
    if (path === '/api/auth/request-password-reset') {
      const user = accounts.find((u) => u.email === body.email);
      if (user) resetTokens.set(`reset${String(resetTokens.size + 1)}`, user);
      return json(route, 200, { status: true });
    }
    if (path === '/api/auth/reset-password') {
      const user = resetTokens.get(body.token ?? '');
      if (!user) return json(route, 400, { code: 'INVALID_TOKEN' });
      resetTokens.delete(body.token ?? '');
      user.password = body.newPassword ?? '';
      session = null;
      return json(route, 200, { status: true });
    }
    if (path === '/api/auth/sign-out') {
      session = null;
      return json(route, 200, { success: true });
    }
    return json(route, 404, problem(404, 'Not Found'));
  });

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!session) return json(route, 401, problem(401, 'Unauthorized'));
    const user = session;

    if (path === '/api/v1/me') {
      return json(route, 200, {
        user: { id: user.id, name: user.name, email: user.email },
        organizations: user.organizations.map(({ organizationId, name, role }) => ({
          organizationId,
          name,
          role,
        })),
      });
    }
    if (path === '/api/v1/organizations' && request.method() === 'POST') {
      const { name } = request.postDataJSON() as { name: string };
      const organization: FakeOrganization = {
        organizationId: nextId(),
        name,
        role: 'owner',
        posts: [],
      };
      user.organizations.push(organization);
      return json(route, 201, { organizationId: organization.organizationId, name, role: 'owner' });
    }

    const organizationId = (await request.allHeaders())['x-organization-id'];
    if (!organizationId) return json(route, 400, problem(400, 'Bad Request'));
    organizationHeaders.push(organizationId);
    const organization = user.organizations.find((o) => o.organizationId === organizationId);
    if (!organization) return json(route, 403, problem(403, 'Forbidden'));

    if (path === '/api/v1/posts') {
      const date = '2026-11-10T14:30:00.000Z';
      return json(route, 200, {
        items: organization.posts.map((body) => ({
          id: nextId(),
          workspaceId: nextId(),
          body,
          createdAt: date,
          updatedAt: date,
        })),
        nextCursor: null,
      });
    }
    return json(route, 404, problem(404, 'Not Found'));
  });

  return {
    organizationHeaders,
    /** What opening the emailed confirmation link does: verifies the address and signs in. */
    confirmEmail(email: string) {
      const user = accounts.find((u) => u.email === email);
      if (!user) throw new Error(`no account for ${email}`);
      user.verified = true;
      session = user;
    },
    /** Tokens of the reset links "emailed" so far. */
    resetTokens: () => [...resetTokens.keys()],
  };
}
