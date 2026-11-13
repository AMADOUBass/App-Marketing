import type { SignInInput, SignUpInput } from '@ponctua/contracts';

export type AuthErrorKind =
  | 'invalidCredentials'
  | 'emailNotVerified'
  | 'passwordTooShort'
  | 'invalidEmail'
  | 'invalidToken'
  | 'tooManyAttempts'
  | 'unknown';

export class AuthError extends Error {
  override readonly name = 'AuthError';

  constructor(readonly kind: AuthErrorKind) {
    super(kind);
  }
}

/** Better Auth error codes (checked by apps/api/test/auth.test.ts) mapped to messages we translate. */
const ERROR_KINDS: Record<string, AuthErrorKind> = {
  INVALID_EMAIL_OR_PASSWORD: 'invalidCredentials',
  EMAIL_NOT_VERIFIED: 'emailNotVerified',
  PASSWORD_TOO_SHORT: 'passwordTooShort',
  INVALID_EMAIL: 'invalidEmail',
  INVALID_TOKEN: 'invalidToken',
};

/** Web pages the emailed links come back to (same paths as the API's EMAIL_VERIFIED_PATH…). */
export const EMAIL_VERIFIED_PATH = '/email-verified';
export const RESET_PASSWORD_PATH = '/reset-password';

/**
 * Better Auth endpoints. The session is an httpOnly cookie set by the server: nothing to store here,
 * and the API strips the session token from JSON bodies (ADR 008).
 */
async function post(path: string, body: object = {}): Promise<void> {
  const response = await fetch(`/api/auth${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (response.ok) return;
  if (response.status === 429) throw new AuthError('tooManyAttempts');

  const error: unknown = await response.json().catch(() => null);
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : '';
  throw new AuthError(ERROR_KINDS[code] ?? 'unknown');
}

export const authApi = {
  /** An unverified address gets a fresh verification link (emailNotVerified). */
  signIn: (input: SignInInput) =>
    post('/sign-in/email', { ...input, callbackURL: EMAIL_VERIFIED_PATH }),
  /**
   * Opens no session: the emailed link does. Same answer whether or not the address already has an
   * account (the owner is warned by email instead).
   */
  signUp: (input: SignUpInput) =>
    post('/sign-up/email', { ...input, callbackURL: EMAIL_VERIFIED_PATH }),
  signOut: () => post('/sign-out'),
  /** Same answer for unknown addresses. */
  requestPasswordReset: (email: string) =>
    post('/request-password-reset', { email, redirectTo: RESET_PASSWORD_PATH }),
  /** Signs out every session of the account. */
  resetPassword: (token: string, newPassword: string) =>
    post('/reset-password', { token, newPassword }),
};
