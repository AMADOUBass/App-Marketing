import { type PasskeySummary, passkeyListSchema } from '@ponctua/contracts';
import {
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
  WebAuthnError,
} from '@simplewebauthn/browser';
import { AuthError, authRequest } from './auth';

/**
 * Passkeys (ADR 011): the browser and the device do the cryptography (WebAuthn); the server only
 * keeps public keys. The device asks for a PIN or biometrics: the server refuses a passkey without it.
 */

/** The user closed the device prompt, or the request timed out: not an error worth an alert. */
function isCancelled(error: unknown): boolean {
  return (
    (error instanceof WebAuthnError && error.code === 'ERROR_CEREMONY_ABORTED') ||
    (error instanceof Error && (error.name === 'NotAllowedError' || error.name === 'AbortError'))
  );
}

async function ceremony<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError(isCancelled(error) ? 'passkeyCancelled' : 'passkeyFailed');
  }
}

export const passkeys = {
  /** Hidden where WebAuthn is missing (old browsers, some embedded views). */
  supported: (): boolean => browserSupportsWebAuthn(),
  autofillSupported: (): Promise<boolean> => browserSupportsWebAuthnAutofill(),

  /** Needs a recent session (sessionNotFresh otherwise); the owner is told by email. */
  add: (name: string): Promise<void> =>
    ceremony(async () => {
      const optionsJSON = (await authRequest(
        'GET',
        '/passkey/generate-register-options',
      )) as PublicKeyCredentialCreationOptionsJSON;
      const response = await startRegistration({ optionsJSON });
      await authRequest('POST', '/passkey/verify-registration', {
        response,
        ...(name.trim() ? { name: name.trim() } : {}),
      });
    }),

  /**
   * Signs in without typing an address: the device offers its passkeys for this site. With
   * `autofill`, waits quietly for the user to pick one in the email field's suggestions.
   */
  signIn: (autofill = false): Promise<void> =>
    ceremony(async () => {
      const optionsJSON = (await authRequest(
        'GET',
        '/passkey/generate-authenticate-options',
      )) as PublicKeyCredentialRequestOptionsJSON;
      const response = await startAuthentication({ optionsJSON, useBrowserAutofill: autofill });
      await authRequest('POST', '/passkey/verify-authentication', { response });
    }),

  /** Stops a pending autofill request (leaving the page, or starting another one). */
  cancelPending: (): void => {
    WebAuthnAbortService.cancelCeremony();
  },

  list: async (): Promise<PasskeySummary[]> =>
    passkeyListSchema.parse(await authRequest('GET', '/passkey/list-user-passkeys')),

  /** The owner is told by email. */
  remove: async (id: string): Promise<void> => {
    await authRequest('POST', '/passkey/delete-passkey', { id });
  },
};
