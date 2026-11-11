import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEV_TENANT_HEADER } from '../src/lib/api';
import { useSession } from '../src/lib/session';
import { mockApi, ORG_ID, post, renderApp } from './helpers';

beforeEach(() => {
  useSession.getState().signIn(ORG_ID);
});

describe('posts page', () => {
  it('lists the organization posts, asking the API for that organization only', async () => {
    const requests = mockApi({
      body: { items: [post('Premier post'), post('Deuxième post', 1)], nextCursor: null },
    });
    renderApp('/posts');

    expect(await screen.findByText('Premier post')).toBeTruthy();
    expect(screen.getByText('Deuxième post')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Publications' })).toBeTruthy();
    expect(requests[0]?.url).toBe('/api/v1/posts?limit=20');
    expect(requests[0]?.headers.get(DEV_TENANT_HEADER)).toBe(ORG_ID);
  });

  it('shows an empty state', async () => {
    mockApi({ body: { items: [], nextCursor: null } });
    renderApp('/posts');

    expect(await screen.findByText("Aucune publication pour l'instant.")).toBeTruthy();
  });

  it('loads the next page with the cursor', async () => {
    const first = post('Page 1');
    const requests = mockApi(
      { body: { items: [first], nextCursor: first.id } },
      { body: { items: [post('Page 2', 1)], nextCursor: null } },
    );
    renderApp('/posts');

    await userEvent.click(await screen.findByRole('button', { name: 'Charger plus' }));

    expect(await screen.findByText('Page 2')).toBeTruthy();
    expect(screen.getByText('Page 1')).toBeTruthy();
    expect(requests[1]?.url).toBe(`/api/v1/posts?limit=20&cursor=${first.id}`);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Charger plus' })).toBeNull();
    });
  });

  it('shows an error with a retry button', async () => {
    mockApi(
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
    mockApi({ body: { items: [{ id: 'oops' }], nextCursor: null } });
    renderApp('/posts');

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Impossible de charger les publications.',
    );
  });

  it('goes back to sign-in when the API refuses the organization (401)', async () => {
    mockApi({ status: 401, body: { type: 'about:blank', title: 'Unauthorized', status: 401 } });
    const { history } = renderApp('/posts');

    await waitFor(() => {
      expect(history.location.pathname).toBe('/login');
    });
    expect(useSession.getState().organizationId).toBeNull();
  });
});
