import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ORGANIZATION_HEADER } from '../src/lib/api';
import { useSession } from '../src/lib/session';
import {
  me,
  mockApi,
  ORG_A,
  ORG_B,
  ORG_ID,
  OTHER_ORG_ID,
  post,
  renderApp,
  SIGNED_OUT,
} from './helpers';

describe('organization switching (multi-tenant)', () => {
  it('after switching, only the new organization is asked for and shown', async () => {
    useSession.getState().selectOrganization(ORG_ID);
    const api = mockApi({
      '/api/v1/me': { body: me([ORG_A, ORG_B]) },
      '/api/v1/posts': [
        { body: { items: [post('Secret de A')], nextCursor: null } },
        { body: { items: [post('Post de B')], nextCursor: null } },
      ],
    });
    renderApp('/posts');
    expect(await screen.findByText('Secret de A')).toBeTruthy();

    await userEvent.selectOptions(screen.getByLabelText('Organisation'), 'Agence Démo B');

    expect(await screen.findByText('Post de B')).toBeTruthy();
    expect(screen.queryByText('Secret de A')).toBeNull();
    expect(useSession.getState().organizationId).toBe(OTHER_ORG_ID);
    const posts = api.to('/api/v1/posts');
    expect(posts.map((request) => request.headers.get(ORGANIZATION_HEADER))).toEqual([
      ORG_ID,
      OTHER_ORG_ID,
    ]);
  });

  it('an organization the user no longer belongs to is dropped: choose again', async () => {
    // Stored selection from an earlier visit; the user has since been removed from it.
    useSession.getState().selectOrganization('0195f000-0000-7000-8000-0000000000ff');
    const api = mockApi({ '/api/v1/me': { body: me([ORG_A, ORG_B]) } });
    const { history } = renderApp('/posts');

    await waitFor(() => {
      expect(history.location.pathname).toBe('/organizations');
    });
    expect(useSession.getState().organizationId).toBeNull();
    expect(api.to('/api/v1/posts')).toHaveLength(0);
  });

  it('with a single organization the name is shown, without a selector', async () => {
    useSession.getState().selectOrganization(ORG_ID);
    mockApi({
      '/api/v1/me': { body: me([ORG_A]) },
      '/api/v1/posts': { body: { items: [], nextCursor: null } },
    });
    renderApp('/posts');

    expect(await screen.findByText('Agence Démo A')).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});

describe('sign-out', () => {
  it('ends the session on the server, forgets the organization and the cached data', async () => {
    useSession.getState().selectOrganization(ORG_ID);
    const api = mockApi({
      '/api/v1/me': [{ body: me() }, SIGNED_OUT],
      '/api/v1/posts': { body: { items: [post('Post confidentiel')], nextCursor: null } },
      'POST /api/auth/sign-out': { body: { success: true } },
    });
    const { history, queryClient } = renderApp('/posts');
    expect(await screen.findByText('Post confidentiel')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Se déconnecter' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Connexion' })).toBeTruthy();
    expect(history.location.pathname).toBe('/login');
    expect(api.to('/api/auth/sign-out')).toHaveLength(1);
    expect(useSession.getState().organizationId).toBeNull();
    expect(queryClient.getQueryData(['posts', ORG_ID])).toBeUndefined();
  });

  it('stays signed in and says so when sign-out fails', async () => {
    useSession.getState().selectOrganization(ORG_ID);
    mockApi({
      '/api/v1/me': { body: me() },
      '/api/v1/posts': { body: { items: [], nextCursor: null } },
      'POST /api/auth/sign-out': { status: 500, body: {} },
    });
    const { history } = renderApp('/posts');

    await userEvent.click(await screen.findByRole('button', { name: 'Se déconnecter' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'La déconnexion a échoué. Réessayez.',
    );
    expect(history.location.pathname).toBe('/posts');
  });
});

describe('page errors', () => {
  it('shows a generic message when the session cannot be checked (API down)', async () => {
    mockApi({ '/api/v1/me': { status: 500, body: {} } });
    renderApp('/posts');

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Impossible de charger la page.',
    );
  });

  it('the session check uses the cookie only: no organization header on /me', async () => {
    const api = mockApi({ '/api/v1/me': SIGNED_OUT });
    renderApp('/');

    await screen.findByRole('heading', { level: 1, name: 'Connexion' });
    const [request] = api.to('/api/v1/me');
    expect(request?.headers.get(ORGANIZATION_HEADER)).toBeNull();
    expect(request?.credentials).toBe('same-origin');
  });
});

describe('expired session', () => {
  it('a refresh of /me that finds no session goes back to sign-in', async () => {
    useSession.getState().selectOrganization(ORG_ID);
    mockApi({
      '/api/v1/me': [{ body: me() }, SIGNED_OUT],
      '/api/v1/posts': { body: { items: [], nextCursor: null } },
    });
    const { history, queryClient } = renderApp('/posts');
    await screen.findByRole('heading', { level: 1, name: 'Publications' });

    await queryClient.refetchQueries({ queryKey: ['me'] });

    await waitFor(() => {
      expect(history.location.pathname).toBe('/login');
    });
    expect(useSession.getState().organizationId).toBeNull();
  });
});
