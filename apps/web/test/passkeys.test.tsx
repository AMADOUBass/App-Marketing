import * as webauthn from '@simplewebauthn/browser';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORGANIZATION_HEADER } from '../src/lib/api';
import { useSession } from '../src/lib/session';
import { authError, me, mockApi, ORG_A, ORG_ID, renderApp, SIGNED_OUT } from './helpers';

// jsdom has no WebAuthn: the device side is replaced; the API side is mocked per test.
vi.mock('@simplewebauthn/browser', async (importOriginal) => {
  const actual = await importOriginal<typeof webauthn>();
  return {
    ...actual,
    browserSupportsWebAuthn: vi.fn(() => true),
    browserSupportsWebAuthnAutofill: vi.fn(() => Promise.resolve(false)),
    startRegistration: vi.fn(),
    startAuthentication: vi.fn(),
    WebAuthnAbortService: { cancelCeremony: vi.fn() },
  };
});

const REQUEST_OPTIONS = { challenge: 'c2lnbi1pbg', rpId: 'localhost', allowCredentials: [] };
const CREATION_OPTIONS = { challenge: 'cmVnaXN0ZXI', rp: { id: 'localhost', name: 'Ponctua' } };
const ASSERTION = { id: 'cred-1', rawId: 'cred-1', type: 'public-key', response: {} };
const ATTESTATION = { id: 'cred-2', rawId: 'cred-2', type: 'public-key', response: {} };
const PASSKEY = {
  id: 'pk-1',
  name: 'MacBook',
  createdAt: '2026-11-10T14:30:00.000Z',
  deviceType: 'multiDevice',
  backedUp: true,
};

beforeEach(() => {
  vi.mocked(webauthn.browserSupportsWebAuthn).mockReturnValue(true);
  vi.mocked(webauthn.browserSupportsWebAuthnAutofill).mockResolvedValue(false);
  vi.mocked(webauthn.startAuthentication).mockReset();
  vi.mocked(webauthn.startRegistration).mockReset();
});

describe('signing in with a passkey', () => {
  it('asks the device, sends its answer, and lands in the app — no address typed', async () => {
    vi.mocked(webauthn.startAuthentication).mockResolvedValue(ASSERTION as never);
    const api = mockApi({
      '/api/v1/me': [SIGNED_OUT, { body: me([ORG_A]) }],
      'GET /api/auth/passkey/generate-authenticate-options': { body: REQUEST_OPTIONS },
      'POST /api/auth/passkey/verify-authentication': { body: { user: { id: 'u' } } },
      '/api/v1/posts': { body: { items: [], nextCursor: null } },
    });
    const { history } = renderApp('/login');

    await userEvent.click(
      await screen.findByRole('button', { name: 'Se connecter avec une passkey' }),
    );

    await waitFor(() => {
      expect(history.location.pathname).toBe('/posts');
    });
    expect(webauthn.startAuthentication).toHaveBeenCalledWith({
      optionsJSON: REQUEST_OPTIONS,
      useBrowserAutofill: false,
    });
    const [verify] = api.to('/api/auth/passkey/verify-authentication');
    expect(verify?.body).toEqual({ response: ASSERTION });
    expect(verify?.headers.get(ORGANIZATION_HEADER)).toBeNull();
  });

  it('closing the device prompt is not an error', async () => {
    vi.mocked(webauthn.startAuthentication).mockRejectedValue(
      Object.assign(new Error('closed'), { name: 'NotAllowedError' }),
    );
    mockApi({
      '/api/v1/me': SIGNED_OUT,
      'GET /api/auth/passkey/generate-authenticate-options': { body: REQUEST_OPTIONS },
    });
    renderApp('/login');

    await userEvent.click(
      await screen.findByRole('button', { name: 'Se connecter avec une passkey' }),
    );

    await waitFor(() => {
      expect(webauthn.startAuthentication).toHaveBeenCalled();
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('explains when the device did not check it is you (no PIN or biometrics)', async () => {
    vi.mocked(webauthn.startAuthentication).mockResolvedValue(ASSERTION as never);
    mockApi({
      '/api/v1/me': SIGNED_OUT,
      'GET /api/auth/passkey/generate-authenticate-options': { body: REQUEST_OPTIONS },
      'POST /api/auth/passkey/verify-authentication': authError(401, 'USER_VERIFICATION_REQUIRED'),
    });
    renderApp('/login');

    await userEvent.click(
      await screen.findByRole('button', { name: 'Se connecter avec une passkey' }),
    );

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Votre appareil doit vérifier votre identité',
    );
  });

  it('offers passkeys in the email field suggestions where the browser can (autofill)', async () => {
    vi.mocked(webauthn.browserSupportsWebAuthnAutofill).mockResolvedValue(true);
    vi.mocked(webauthn.startAuthentication).mockReturnValue(new Promise(() => undefined));
    mockApi({
      '/api/v1/me': SIGNED_OUT,
      'GET /api/auth/passkey/generate-authenticate-options': { body: REQUEST_OPTIONS },
    });
    renderApp('/login');

    const email = await screen.findByLabelText('Adresse courriel');
    expect(email.getAttribute('autocomplete')).toBe('username webauthn');
    await waitFor(() => {
      expect(webauthn.startAuthentication).toHaveBeenCalledWith({
        optionsJSON: REQUEST_OPTIONS,
        useBrowserAutofill: true,
      });
    });
  });

  it('shows no passkey button where the browser cannot use them', async () => {
    vi.mocked(webauthn.browserSupportsWebAuthn).mockReturnValue(false);
    mockApi({ '/api/v1/me': SIGNED_OUT });
    renderApp('/login');

    await screen.findByRole('heading', { level: 1, name: 'Connexion' });
    expect(screen.queryByRole('button', { name: 'Se connecter avec une passkey' })).toBeNull();
  });
});

describe('managing passkeys on the security page', () => {
  beforeEach(() => {
    useSession.getState().selectOrganization(ORG_ID);
  });

  it('lists them and adds one, named, through the device', async () => {
    vi.mocked(webauthn.startRegistration).mockResolvedValue(ATTESTATION as never);
    const api = mockApi({
      '/api/v1/me': { body: me() },
      'GET /api/auth/passkey/list-user-passkeys': [{ body: [] }, { body: [PASSKEY] }],
      'GET /api/auth/passkey/generate-register-options': { body: CREATION_OPTIONS },
      'POST /api/auth/passkey/verify-registration': { body: { id: 'pk-1' } },
    });
    renderApp('/settings/security');

    expect(await screen.findByText('Aucune passkey pour l’instant.')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Nom de la passkey (facultatif)'), ' MacBook ');
    await userEvent.click(screen.getByRole('button', { name: 'Ajouter une passkey' }));

    expect((await screen.findByRole('status')).textContent).toBe(
      'Passkey ajoutée. Un courriel de confirmation vous a été envoyé.',
    );
    expect(await screen.findByText('MacBook')).toBeTruthy();
    expect(screen.getByText(/Synchronisée entre vos appareils/)).toBeTruthy();
    expect(webauthn.startRegistration).toHaveBeenCalledWith({ optionsJSON: CREATION_OPTIONS });
    expect(api.to('/api/auth/passkey/verify-registration')[0]?.body).toEqual({
      response: ATTESTATION,
      name: 'MacBook',
    });
  });

  it('an old session must sign in again before adding one', async () => {
    const api = mockApi({
      '/api/v1/me': [{ body: me() }, SIGNED_OUT],
      'GET /api/auth/passkey/list-user-passkeys': { body: [] },
      'GET /api/auth/passkey/generate-register-options': authError(403, 'SESSION_NOT_FRESH'),
      'POST /api/auth/sign-out': { body: { success: true } },
    });
    const { history } = renderApp('/settings/security');

    await userEvent.click(await screen.findByRole('button', { name: 'Ajouter une passkey' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'ajouter une passkey demande une connexion récente',
    );
    expect(webauthn.startRegistration).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Se reconnecter' }));
    await waitFor(() => {
      expect(history.location.pathname).toBe('/login');
    });
    expect(api.to('/api/auth/sign-out')).toHaveLength(1);
  });

  it('removes one with a button that names it', async () => {
    const api = mockApi({
      '/api/v1/me': { body: me() },
      'GET /api/auth/passkey/list-user-passkeys': [{ body: [PASSKEY] }, { body: [] }],
      'POST /api/auth/passkey/delete-passkey': { body: { status: true } },
    });
    renderApp('/settings/security');

    await userEvent.click(
      await screen.findByRole('button', { name: 'Supprimer la passkey MacBook' }),
    );

    expect((await screen.findByRole('status')).textContent).toBe(
      'Passkey supprimée. Un courriel de confirmation vous a été envoyé.',
    );
    expect(api.to('/api/auth/passkey/delete-passkey')[0]?.body).toEqual({ id: 'pk-1' });
    expect(await screen.findByText('Aucune passkey pour l’instant.')).toBeTruthy();
  });
});
