import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ORGANIZATION_HEADER } from '../src/lib/api';
import { useSession } from '../src/lib/session';
import { authError, me, mockApi, ORG_A, ORG_ID, renderApp, SIGNED_OUT } from './helpers';

async function signUp(name: string, email: string, password: string) {
  await userEvent.type(await screen.findByLabelText('Nom'), name);
  await userEvent.type(screen.getByLabelText('Adresse courriel'), email);
  await userEvent.type(screen.getByLabelText('Mot de passe'), password);
  await userEvent.click(screen.getByRole('button', { name: 'Créer mon compte' }));
}

describe('sign-up and onboarding', () => {
  it('states the password rule up front and enforces it before calling the server', async () => {
    const api = mockApi({ '/api/v1/me': SIGNED_OUT });
    renderApp('/signup');

    const password = await screen.findByLabelText('Mot de passe');
    expect(password.getAttribute('autocomplete')).toBe('new-password');
    const hintId = password.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(hintId)?.textContent).toContain('Au moins 12 caractères');

    await signUp('Amélie', 'amelie@agence.ca', 'trop-court');

    expect(password.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Le mot de passe doit contenir au moins 12 caractères.')).toBeTruthy();
    expect(api.to('/api/auth/sign-up/email')).toHaveLength(0);
  });

  it('a new user creates an organization, becomes its owner and lands in it', async () => {
    const api = mockApi({
      '/api/v1/me': [SIGNED_OUT, { body: me([]) }, { body: me([ORG_A]) }],
      'POST /api/auth/sign-up/email': { body: { user: { id: 'u' } } },
      'POST /api/v1/organizations': { status: 201, body: ORG_A },
      '/api/v1/posts': { body: { items: [], nextCursor: null } },
    });
    const { history } = renderApp('/signup');

    await signUp('Amélie Tremblay', 'amelie@agence.ca', 'correct-horse-battery');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Créer votre organisation' }),
    ).toBeTruthy();
    expect(api.to('/api/auth/sign-up/email')[0]?.body).toEqual({
      name: 'Amélie Tremblay',
      email: 'amelie@agence.ca',
      password: 'correct-horse-battery',
    });

    await userEvent.type(screen.getByLabelText("Nom de l'organisation"), 'Agence Démo A');
    await userEvent.click(screen.getByRole('button', { name: "Créer l'organisation" }));

    await waitFor(() => {
      expect(history.location.pathname).toBe('/posts');
    });
    const [create] = api.to('/api/v1/organizations');
    expect(create?.body).toEqual({ name: 'Agence Démo A' });
    // Creating an organization acts for the user, not for an organization.
    expect(create?.headers.get(ORGANIZATION_HEADER)).toBeNull();
    expect(useSession.getState().organizationId).toBe(ORG_ID);
  });

  it('refuses an organization name that is too short', async () => {
    const api = mockApi({ '/api/v1/me': { body: me([]) } });
    renderApp('/organizations/new');

    await userEvent.type(await screen.findByLabelText("Nom de l'organisation"), 'A');
    await userEvent.click(screen.getByRole('button', { name: "Créer l'organisation" }));

    expect(screen.getByText('Le nom doit contenir entre 2 et 120 caractères.')).toBeTruthy();
    expect(api.to('/api/v1/organizations')).toHaveLength(0);
  });

  it('says when the email is already used', async () => {
    mockApi({
      '/api/v1/me': SIGNED_OUT,
      'POST /api/auth/sign-up/email': authError(422, 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL'),
    });
    renderApp('/signup');

    await signUp('Amélie', 'amelie@agence.ca', 'correct-horse-battery');

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Un compte existe déjà avec cette adresse. Connectez-vous plutôt.',
    );
  });

  it('links sign-in and sign-up pages both ways', async () => {
    mockApi({ '/api/v1/me': SIGNED_OUT });
    renderApp('/login');

    await userEvent.click(await screen.findByRole('link', { name: 'Créer un compte' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Créer un compte' })).toBeTruthy();
    await userEvent.click(screen.getByRole('link', { name: 'Se connecter' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Connexion' })).toBeTruthy();
  });
});
