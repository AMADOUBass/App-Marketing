import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ORGANIZATION_HEADER } from '../src/lib/api';
import { useSession } from '../src/lib/session';
import { me, mockApi, ORG_A, ORG_ID, renderApp, SIGNED_OUT } from './helpers';

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

  it('sign-up asks to confirm the address by email, and opens no session', async () => {
    const api = mockApi({
      '/api/v1/me': SIGNED_OUT,
      'POST /api/auth/sign-up/email': { body: { token: null, user: { id: 'u' } } },
    });
    renderApp('/signup');

    await signUp('Amélie Tremblay', 'amelie@agence.ca', 'correct-horse-battery');

    const heading = await screen.findByRole('heading', { name: 'Vérifiez vos courriels' });
    // Focus moves to the outcome, so screen readers announce it.
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
    expect(screen.getByText(/amelie@agence\.ca/)).toBeTruthy();
    expect(api.to('/api/auth/sign-up/email')[0]?.body).toEqual({
      name: 'Amélie Tremblay',
      email: 'amelie@agence.ca',
      password: 'correct-horse-battery',
      callbackURL: '/email-verified',
    });
    // The same screen whether or not the address already had an account (the server answers the
    // same): no "address already used" message exists any more.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('after the emailed link, a new user creates an organization, becomes its owner and lands in it', async () => {
    const api = mockApi({
      '/api/v1/me': [{ body: me([]) }, { body: me([ORG_A]) }],
      'POST /api/v1/organizations': { status: 201, body: ORG_A },
      '/api/v1/posts': { body: { items: [], nextCursor: null } },
    });
    const { history } = renderApp('/email-verified');

    expect(await screen.findByRole('heading', { name: 'Adresse confirmée' })).toBeTruthy();
    await userEvent.click(screen.getByRole('link', { name: 'Continuer' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Créer votre organisation' }),
    ).toBeTruthy();

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

  it('an invalid or expired confirmation link says so and points to sign-in', async () => {
    mockApi({ '/api/v1/me': SIGNED_OUT });
    renderApp('/email-verified?error=invalid_token');

    expect(await screen.findByRole('heading', { name: 'Lien invalide ou expiré' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Se connecter' }).getAttribute('href')).toBe('/login');
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
