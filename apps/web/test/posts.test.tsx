import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { ORGANIZATION_HEADER } from '../src/lib/api';
import { useSession } from '../src/lib/session';
import { me, mockApi, ORG_ID, post, type Reply, renderApp, SIGNED_OUT } from './helpers';

const withPosts = (...replies: Reply[]) =>
  mockApi({ '/api/v1/me': { body: me() }, '/api/v1/posts': replies });

beforeEach(() => {
  useSession.getState().selectOrganization(ORG_ID);
});

describe('posts page', () => {
  it('lists the organization posts, asking the API for that organization only', async () => {
    const api = withPosts({
      body: { items: [post('Premier post'), post('Deuxième post', 1)], nextCursor: null },
    });
    renderApp('/posts');

    expect(await screen.findByText('Premier post')).toBeTruthy();
    expect(screen.getByText('Deuxième post')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Publications' })).toBeTruthy();
    const [request] = api.to('/api/v1/posts');
    expect(request?.url).toBe('/api/v1/posts?limit=20');
    expect(request?.headers.get(ORGANIZATION_HEADER)).toBe(ORG_ID);
  });

  it('shows an empty state', async () => {
    withPosts({ body: { items: [], nextCursor: null } });
    renderApp('/posts');

    expect(await screen.findByText("Aucune publication pour l'instant.")).toBeTruthy();
  });

  it('loads the next page with the cursor', async () => {
    const first = post('Page 1');
    const api = withPosts(
      { body: { items: [first], nextCursor: first.id } },
      { body: { items: [post('Page 2', 1)], nextCursor: null } },
    );
    renderApp('/posts');

    await userEvent.click(await screen.findByRole('button', { name: 'Charger plus' }));

    expect(await screen.findByText('Page 2')).toBeTruthy();
    expect(screen.getByText('Page 1')).toBeTruthy();
    expect(api.to('/api/v1/posts')[1]?.url).toBe(`/api/v1/posts?limit=20&cursor=${first.id}`);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Charger plus' })).toBeNull();
    });
  });

  it('shows an error with a retry button', async () => {
    withPosts(
      { status: 500, body: { type: 'about:blank', title: 'Internal Server Error', status: 500 } },
      { body: { items: [post('Après la panne')], nextCursor: null } },
    );
    renderApp('/posts');

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Impossible de charger les publications.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Réessayer' }));

    expect(await screen.findByText('Après la panne')).toBeTruthy();
  });

  it('rejects a response that does not match the shared contract', async () => {
    withPosts({ body: { items: [{ id: 'oops' }], nextCursor: null } });
    renderApp('/posts');

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Impossible de charger les publications.',
    );
  });

  it('goes back to sign-in when the session has expired (401), forgetting the organization', async () => {
    // /me answered before expiry, then the session is gone.
    mockApi({ '/api/v1/me': [{ body: me() }, SIGNED_OUT], '/api/v1/posts': SIGNED_OUT });
    const { history } = renderApp('/posts');

    await waitFor(() => {
      expect(history.location.pathname).toBe('/login');
    });
    expect(useSession.getState().organizationId).toBeNull();
  });
});
