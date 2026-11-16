import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { ORGANIZATION_HEADER } from '../src/lib/api';
import { useSession } from '../src/lib/session';
import { authError, me, mockApi, ORG_A, ORG_ID, renderApp, SIGNED_OUT } from './helpers';

const TOTP_URI = 'otpauth://totp/Ponctua:amelie%40agence.ca?secret=JBSWY3DPEHPK3PXP&issuer=Ponctua';
const BACKUP_CODES = Array.from({ length: 10 }, (_, i) => `AAAA${String(i)}-BBBB${String(i)}`);
const NO_POSTS = { body: { items: [], nextCursor: null } };

async function passwordStep() {
  await userEvent.type(await screen.findByLabelText('Adresse courriel'), 'amelie@agence.ca');
  await userEvent.type(screen.getByLabelText('Mot de passe'), 'correct-horse-battery');
  await userEvent.click(screen.getByRole('button', { name: 'Se connecter' }));
}

describe('sign-in with two-factor authentication', () => {
  it('after the password, asks for the app code; the session opens only after it', async () => {
    const api = mockApi({
      '/api/v1/me': [SIGNED_OUT, { body: me([ORG_A], { twoFactorEnabled: true }) }],
      'POST /api/auth/sign-in/email': {
        body: { twoFactorRedirect: true, twoFactorMethods: ['totp'] },
      },
      'POST /api/auth/two-factor/verify-totp': { body: { user: { id: 'u' } } },
      '/api/v1/posts': NO_POSTS,
    });
    const { history } = renderApp('/login');

    await passwordStep();

    const heading = await screen.findByRole('heading', { name: 'Vérification en deux étapes' });
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
    const field = screen.getByLabelText('Code de vérification');
    expect(field.getAttribute('autocomplete')).toBe('one-time-code');
    expect(field.getAttribute('inputmode')).toBe('numeric');
    // Nothing asked from the API yet: no session after the password alone.
    expect(api.to('/api/v1/me')).toHaveLength(1);

    await userEvent.type(field, '123 456');
    await userEvent.click(screen.getByRole('button', { name: 'Vérifier' }));

    await waitFor(() => {
      expect(history.location.pathname).toBe('/posts');
    });
    expect(api.to('/api/auth/two-factor/verify-totp')[0]?.body).toEqual({
      code: '123456',
      trustDevice: false,
    });
  });

  it('checks the code format first, and says when the server refuses it', async () => {
    const api = mockApi({
      '/api/v1/me': SIGNED_OUT,
      'POST /api/auth/sign-in/email': { body: { twoFactorRedirect: true } },
      'POST /api/auth/two-factor/verify-totp': authError(401, 'INVALID_CODE'),
    });
    renderApp('/login');
    await passwordStep();

    const field = await screen.findByLabelText('Code de vérification');
    await userEvent.type(field, '12');
    await userEvent.click(screen.getByRole('button', { name: 'Vérifier' }));
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(api.to('/api/auth/two-factor/verify-totp')).toHaveLength(0);

    await userEvent.clear(field);
    await userEvent.type(field, '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Vérifier' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Code incorrect.');
  });

  it('a backup code can be used instead, and "trust this device" is sent', async () => {
    const api = mockApi({
      '/api/v1/me': [SIGNED_OUT, { body: me([ORG_A], { twoFactorEnabled: true }) }],
      'POST /api/auth/sign-in/email': { body: { twoFactorRedirect: true } },
      'POST /api/auth/two-factor/verify-backup-code': { body: { user: { id: 'u' } } },
      '/api/v1/posts': NO_POSTS,
    });
    const { history } = renderApp('/login');
    await passwordStep();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Utiliser un code de secours' }),
    );
    await userEvent.type(screen.getByLabelText('Code de secours'), 'AAAA1-BBBB1');
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Faire confiance à cet appareil pendant 30 jours' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Vérifier' }));

    await waitFor(() => {
      expect(history.location.pathname).toBe('/posts');
    });
    expect(api.to('/api/auth/two-factor/verify-backup-code')[0]?.body).toEqual({
      code: 'AAAA1-BBBB1',
      trustDevice: true,
    });
  });

  it('when the 10-minute window is over, offers to start again from the password', async () => {
    mockApi({
      '/api/v1/me': SIGNED_OUT,
      'POST /api/auth/sign-in/email': { body: { twoFactorRedirect: true } },
      'POST /api/auth/two-factor/verify-totp': authError(401, 'INVALID_TWO_FACTOR_COOKIE'),
    });
    renderApp('/login');
    await passwordStep();

    await userEvent.type(await screen.findByLabelText('Code de vérification'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Vérifier' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Recommencer la connexion' }));

    expect(await screen.findByLabelText('Mot de passe')).toBeTruthy();
  });
});

describe('security page', () => {
  beforeEach(() => {
    useSession.getState().selectOrganization(ORG_ID);
  });

  it('is reached from the header, and talks to the account endpoints only (no organization)', async () => {
    const api = mockApi({
      '/api/v1/me': { body: me() },
      '/api/v1/posts': NO_POSTS,
      'POST /api/auth/two-factor/enable': authError(400, 'INVALID_PASSWORD'),
    });
    const { history } = renderApp('/posts');

    await userEvent.click(await screen.findByRole('link', { name: 'Sécurité' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sécurité du compte' }),
    ).toBeTruthy();
    expect(history.location.pathname).toBe('/settings/security');

    await userEvent.click(
      screen.getByRole('button', { name: 'Activer la double authentification' }),
    );
    await userEvent.type(screen.getByLabelText('Confirmez votre mot de passe'), 'wrong-password');
    await userEvent.click(
      screen.getByRole('button', { name: 'Activer la double authentification' }),
    );

    expect((await screen.findByRole('alert')).textContent).toBe('Mot de passe incorrect.');
    const [enable] = api.to('/api/auth/two-factor/enable');
    expect(enable?.headers.get(ORGANIZATION_HEADER)).toBeNull();
  });

  it('turns two-factor on: password, QR code and key, first code, then backup codes once', async () => {
    const api = mockApi({
      '/api/v1/me': [
        { body: me([ORG_A], { twoFactorEnabled: false }) },
        { body: me([ORG_A], { twoFactorEnabled: true }) },
      ],
      'POST /api/auth/two-factor/enable': {
        body: { totpURI: TOTP_URI, backupCodes: BACKUP_CODES },
      },
      'POST /api/auth/two-factor/verify-totp': { body: { token: null, user: { id: 'u' } } },
    });
    renderApp('/settings/security');

    expect(await screen.findByText('désactivée')).toBeTruthy();
    await userEvent.click(
      screen.getByRole('button', { name: 'Activer la double authentification' }),
    );
    await userEvent.type(
      screen.getByLabelText('Confirmez votre mot de passe'),
      'correct-horse-battery',
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Activer la double authentification' }),
    );

    // QR code drawn locally (data URI, never a third-party image) and the key to type by hand.
    const qr = await screen.findByRole('img', {
      name: 'Code QR à scanner avec votre application d’authentification',
    });
    expect(qr.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    expect(screen.getByText('JBSW Y3DP EHPK 3PXP')).toBeTruthy();
    expect(api.to('/api/auth/two-factor/enable')[0]?.body).toEqual({
      password: 'correct-horse-battery',
    });

    await userEvent.type(screen.getByLabelText('Code de vérification'), '654321');
    await userEvent.click(screen.getByRole('button', { name: 'Confirmer et activer' }));

    const list = await screen.findByRole('list', { name: 'Codes de secours' });
    expect(list.querySelectorAll('li')).toHaveLength(10);
    await userEvent.click(screen.getByRole('button', { name: 'J’ai enregistré mes codes' }));

    expect((await screen.findByRole('status')).textContent).toBe(
      'La double authentification est activée.',
    );
    expect(await screen.findByText('activée')).toBeTruthy();
    // The codes are gone from the page once acknowledged.
    expect(screen.queryByText('AAAA0-BBBB0')).toBeNull();
  });

  it('turns two-factor off after the password', async () => {
    const api = mockApi({
      '/api/v1/me': [
        { body: me([ORG_A], { twoFactorEnabled: true }) },
        { body: me([ORG_A], { twoFactorEnabled: false }) },
      ],
      'POST /api/auth/two-factor/disable': { body: { status: true } },
    });
    renderApp('/settings/security');

    await userEvent.click(await screen.findByRole('button', { name: 'Désactiver' }));
    await userEvent.type(
      screen.getByLabelText('Confirmez votre mot de passe'),
      'correct-horse-battery',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Désactiver' }));

    expect((await screen.findByRole('status')).textContent).toContain(
      'La double authentification est désactivée.',
    );
    expect(api.to('/api/auth/two-factor/disable')).toHaveLength(1);
  });

  it('changes the password, always signing out the other sessions', async () => {
    const api = mockApi({
      '/api/v1/me': { body: me() },
      'POST /api/auth/change-password': { body: { user: { id: 'u' } } },
    });
    renderApp('/settings/security');

    await userEvent.type(
      await screen.findByLabelText('Mot de passe actuel'),
      'correct-horse-battery',
    );
    await userEvent.type(screen.getByLabelText('Nouveau mot de passe'), 'court');
    await userEvent.click(screen.getByRole('button', { name: 'Changer le mot de passe' }));
    expect(screen.getByText('Le mot de passe doit contenir au moins 12 caractères.')).toBeTruthy();
    expect(api.to('/api/auth/change-password')).toHaveLength(0);

    await userEvent.clear(screen.getByLabelText('Nouveau mot de passe'));
    await userEvent.type(screen.getByLabelText('Nouveau mot de passe'), 'a-brand-new-passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Changer le mot de passe' }));

    expect((await screen.findByRole('status')).textContent).toBe(
      'Mot de passe modifié. Vos autres sessions ont été fermées.',
    );
    expect(api.to('/api/auth/change-password')[0]?.body).toEqual({
      currentPassword: 'correct-horse-battery',
      newPassword: 'a-brand-new-passphrase',
      revokeOtherSessions: true,
    });
  });
});
