import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ORGANIZATION_HEADER } from '../src/lib/api';
import { useSession } from '../src/lib/session';
import {
  authError,
  me,
  mockApi,
  ORG_A,
  ORG_B,
  ORG_ID,
  OTHER_ORG_ID,
  renderApp,
  SIGNED_OUT,
} from './helpers';

const NO_POSTS = { body: { items: [], nextCursor: null } };

async function fillAndSubmit(email: string, password: string) {
  await userEvent.type(await screen.findByLabelText('Adresse courriel'), email);
  await userEvent.type(screen.getByLabelText('Mot de passe'), password);
  await userEvent.click(screen.getByRole('button', { name: 'Se connecter' }));
}

describe('sign-in', () => {
  it('sends a visitor without session to the sign-in page', async () => {
    mockApi({ '/api/v1/me': SIGNED_OUT });
    const { history } = renderApp('/posts');

    expect(await screen.findByRole('heading', { level: 1, name: 'Connexion' })).toBeTruthy();
    expect(history.location.pathname).toBe('/login');
  });

  it('checks the fields before calling the server, and focuses the first invalid one', async () => {
    const api = mockApi({ '/api/v1/me': SIGNED_OUT });
    renderApp('/login');

    await userEvent.click(await screen.findByRole('button', { name: 'Se connecter' }));

    const email = screen.getByLabelText('Adresse courriel');
    await waitFor(() => {
      expect(document.activeElement).toBe(email);
    });
    expect(email.getAttribute('aria-invalid')).toBe('true');
    const errorId = email.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(errorId)?.textContent).toBe(
      'Saisissez une adresse courriel valide, par exemple nom@agence.ca.',
    );
    expect(screen.getByText('Saisissez votre mot de passe.')).toBeTruthy();
    expect(api.to('/api/auth/sign-in/email')).toHaveLength(0);
  });

  it('says the email or password is wrong, without telling which', async () => {
    mockApi({
      '/api/v1/me': SIGNED_OUT,
      'POST /api/auth/sign-in/email': authError(401, 'INVALID_EMAIL_OR_PASSWORD'),
    });
    renderApp('/login');

    await fillAndSubmit('amelie@agence.ca', 'pas-le-bon-mot-de-passe');

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Adresse courriel ou mot de passe incorrect.',
    );
  });

  it('asks to wait after too many attempts (429)', async () => {
    mockApi({
      '/api/v1/me': SIGNED_OUT,
      'POST /api/auth/sign-in/email': { status: 429, body: { message: 'Too many requests' } },
    });
    renderApp('/login');

    await fillAndSubmit('amelie@agence.ca', 'un-mot-de-passe');

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Trop de tentatives. Patientez une minute, puis réessayez.',
    );
  });

  it('with one organization: signs in, enters it and shows its posts', async () => {
    const api = mockApi({
      '/api/v1/me': [SIGNED_OUT, { body: me([ORG_A]) }],
      'POST /api/auth/sign-in/email': { body: { redirect: false, user: { id: 'u' } } },
      '/api/v1/posts': NO_POSTS,
    });
    const { history } = renderApp('/login');

    await fillAndSubmit('  amelie@agence.ca ', 'correct-horse-battery');

    await waitFor(() => {
      expect(history.location.pathname).toBe('/posts');
    });
    const [signIn] = api.to('/api/auth/sign-in/email');
    expect(signIn?.body).toEqual({ email: 'amelie@agence.ca', password: 'correct-horse-battery' });
    expect(signIn?.credentials).toBe('same-origin');
    expect(useSession.getState().organizationId).toBe(ORG_ID);
    await waitFor(() => {
      expect(api.to('/api/v1/posts')[0]?.headers.get(ORGANIZATION_HEADER)).toBe(ORG_ID);
    });
  });

  it('with several organizations: asks which one, then works in it', async () => {
    const api = mockApi({
      '/api/v1/me': [SIGNED_OUT, { body: me([ORG_A, ORG_B]) }],
      'POST /api/auth/sign-in/email': { body: {} },
      '/api/v1/posts': NO_POSTS,
    });
    const { history } = renderApp('/login');

    await fillAndSubmit('amelie@agence.ca', 'correct-horse-battery');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Choisir une organisation' }),
    ).toBeTruthy();
    expect(screen.getByText('(Propriétaire)')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Ouvrir Agence Démo B' }));

    await waitFor(() => {
      expect(history.location.pathname).toBe('/posts');
    });
    await waitFor(() => {
      expect(api.to('/api/v1/posts')[0]?.headers.get(ORGANIZATION_HEADER)).toBe(OTHER_ORG_ID);
    });
  });

  it('sends a signed-in user away from the sign-in page', async () => {
    useSession.getState().selectOrganization(ORG_ID);
    mockApi({ '/api/v1/me': { body: me() }, '/api/v1/posts': NO_POSTS });
    const { history } = renderApp('/login');

    await waitFor(() => {
      expect(history.location.pathname).toBe('/posts');
    });
  });
});
