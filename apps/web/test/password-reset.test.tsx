import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { authError, mockApi, renderApp, SIGNED_OUT } from './helpers';

const TOKEN = 'resetTokenFromEmail123';

describe('forgotten password', () => {
  it('asks for the address and gives the same answer whatever it is', async () => {
    const api = mockApi({
      '/api/v1/me': SIGNED_OUT,
      'POST /api/auth/request-password-reset': { body: { status: true, message: 'ok' } },
    });
    renderApp('/forgot-password');

    await userEvent.type(await screen.findByLabelText('Adresse courriel'), 'amelie@agence.ca');
    await userEvent.click(screen.getByRole('button', { name: 'Envoyer le lien' }));

    expect(await screen.findByRole('heading', { name: 'Vérifiez vos courriels' })).toBeTruthy();
    expect(screen.getByText(/Si un compte existe pour amelie@agence\.ca/)).toBeTruthy();
    expect(api.to('/api/auth/request-password-reset')[0]?.body).toEqual({
      email: 'amelie@agence.ca',
      redirectTo: '/reset-password',
    });
  });

  it('checks the address before calling the server', async () => {
    const api = mockApi({ '/api/v1/me': SIGNED_OUT });
    renderApp('/forgot-password');

    await userEvent.type(await screen.findByLabelText('Adresse courriel'), 'pas-une-adresse');
    await userEvent.click(screen.getByRole('button', { name: 'Envoyer le lien' }));

    expect(screen.getByLabelText('Adresse courriel').getAttribute('aria-invalid')).toBe('true');
    expect(api.to('/api/auth/request-password-reset')).toHaveLength(0);
  });

  it('asks to wait when too many links were requested (429)', async () => {
    mockApi({
      '/api/v1/me': SIGNED_OUT,
      'POST /api/auth/request-password-reset': { status: 429, body: {} },
    });
    renderApp('/forgot-password');

    await userEvent.type(await screen.findByLabelText('Adresse courriel'), 'amelie@agence.ca');
    await userEvent.click(screen.getByRole('button', { name: 'Envoyer le lien' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Trop de tentatives. Patientez une minute, puis réessayez.',
    );
  });
});

describe('reset page (from the emailed link)', () => {
  it('takes the token out of the address bar, then sets the new password with it', async () => {
    const api = mockApi({ 'POST /api/auth/reset-password': { body: { status: true } } });
    const { history } = renderApp(`/reset-password?token=${TOKEN}`);

    const field = await screen.findByLabelText('Nouveau mot de passe');
    await waitFor(() => {
      expect(history.location.href).toBe('/reset-password');
    });

    await userEvent.type(field, 'a-brand-new-passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer le mot de passe' }));

    expect(await screen.findByRole('heading', { name: 'Mot de passe modifié' })).toBeTruthy();
    expect(api.to('/api/auth/reset-password')[0]?.body).toEqual({
      token: TOKEN,
      newPassword: 'a-brand-new-passphrase',
    });
  });

  it('enforces the password rule before calling the server', async () => {
    const api = mockApi({});
    renderApp(`/reset-password?token=${TOKEN}`);

    await userEvent.type(await screen.findByLabelText('Nouveau mot de passe'), 'court');
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer le mot de passe' }));

    expect(screen.getByText('Le mot de passe doit contenir au moins 12 caractères.')).toBeTruthy();
    expect(api.to('/api/auth/reset-password')).toHaveLength(0);
  });

  it('an expired or used link offers to ask for a new one', async () => {
    mockApi({ 'POST /api/auth/reset-password': authError(400, 'INVALID_TOKEN') });
    renderApp(`/reset-password?token=${TOKEN}`);

    await userEvent.type(
      await screen.findByLabelText('Nouveau mot de passe'),
      'a-brand-new-passphrase',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer le mot de passe' }));

    expect(await screen.findByRole('heading', { name: 'Lien invalide ou expiré' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Demander un nouveau lien' })).toBeTruthy();
  });

  it('a link the API already rejected (?error=) shows the same message, without a form', async () => {
    mockApi({});
    renderApp('/reset-password?error=INVALID_TOKEN');

    expect(await screen.findByRole('heading', { name: 'Lien invalide ou expiré' })).toBeTruthy();
    expect(screen.queryByLabelText('Nouveau mot de passe')).toBeNull();
  });
});
