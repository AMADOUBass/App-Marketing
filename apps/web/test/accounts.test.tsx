import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ORGANIZATION_HEADER } from '../src/lib/api';
import { externalNavigation } from '../src/lib/navigation';
import { useSession } from '../src/lib/session';
import { me, mockApi, ORG_ID, renderApp } from './helpers';

const account = {
  id: '0195f000-0000-7000-8000-000000000301',
  workspaceId: '0195f000-0000-7000-8000-0000000000a1',
  platform: 'instagram',
  displayName: 'abassoum88888',
  externalAccountId: '17841472428926955',
  connected: true,
};

beforeEach(() => {
  useSession.getState().selectOrganization(ORG_ID);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('connected accounts page', () => {
  it('lists the organization accounts, asking the API for that organization only', async () => {
    const api = mockApi({
      '/api/v1/me': { body: me() },
      '/api/v1/social-accounts': { body: { items: [account] } },
    });
    renderApp('/accounts');

    expect(await screen.findByText('@abassoum88888')).toBeTruthy();
    expect(screen.getByText('Connecté')).toBeTruthy();
    const [request] = api.to('/api/v1/social-accounts');
    expect(request?.headers.get(ORGANIZATION_HEADER)).toBe(ORG_ID);
    expect(request?.credentials).toBe('same-origin');
  });

  it('“Connecter Instagram” asks the API for the login URL, then leaves for Meta', async () => {
    const go = vi.spyOn(externalNavigation, 'go').mockImplementation(() => undefined);
    const loginUrl = 'https://www.facebook.com/v27.0/dialog/oauth?client_id=1&state=signed';
    const api = mockApi({
      '/api/v1/me': { body: me() },
      '/api/v1/social-accounts': { body: { items: [] } },
      '/api/v1/integrations/instagram/connect': { body: { loginUrl } },
    });
    renderApp('/accounts');

    await userEvent.click(await screen.findByRole('button', { name: 'Connecter Instagram' }));

    await waitFor(() => {
      expect(go).toHaveBeenCalledWith(loginUrl);
    });
    expect(
      api.to('/api/v1/integrations/instagram/connect')[0]?.headers.get(ORGANIZATION_HEADER),
    ).toBe(ORG_ID);
  });

  it('says so when the server has no Instagram configuration (503)', async () => {
    const go = vi.spyOn(externalNavigation, 'go').mockImplementation(() => undefined);
    mockApi({
      '/api/v1/me': { body: me() },
      '/api/v1/social-accounts': { body: { items: [] } },
      '/api/v1/integrations/instagram/connect': {
        status: 503,
        body: { type: 'about:blank', title: 'Service Unavailable', status: 503 },
      },
    });
    renderApp('/accounts');

    await userEvent.click(await screen.findByRole('button', { name: 'Connecter Instagram' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      "La connexion Instagram n'est pas encore configurée sur ce serveur.",
    );
    expect(go).not.toHaveBeenCalled();
  });

  it.each([
    ['connected', 'status', 'Votre compte Instagram est connecté.'],
    ['cancelled', 'alert', "Connexion annulée : aucun compte n'a été ajouté."],
    ['invalid_state', 'alert', "La connexion a expiré ou n'est pas valide. Recommencez."],
  ])('shows the result of the Meta round trip (?instagram=%s)', async (result, role, text) => {
    mockApi({ '/api/v1/me': { body: me() }, '/api/v1/social-accounts': { body: { items: [] } } });
    renderApp(`/accounts?instagram=${result}`);

    expect((await screen.findByRole(role as 'status' | 'alert')).textContent).toBe(text);
  });

  it('ignores an unknown ?instagram= value', async () => {
    mockApi({ '/api/v1/me': { body: me() }, '/api/v1/social-accounts': { body: { items: [] } } });
    renderApp('/accounts?instagram=<script>');

    expect(await screen.findByText("Aucun compte connecté pour l'instant.")).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('is reachable from the posts page through the main navigation', async () => {
    mockApi({
      '/api/v1/me': { body: me() },
      '/api/v1/posts': { body: { items: [], nextCursor: null } },
    });
    renderApp('/posts');

    const link = await screen.findByRole('link', { name: 'Comptes connectés' });
    expect(link.getAttribute('href')).toBe('/accounts');
  });
});
