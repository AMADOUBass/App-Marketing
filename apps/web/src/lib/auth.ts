import type { SignInInput, SignUpInput } from '@ponctua/contracts';

export type AuthErrorKind =
  | 'invalidCredentials'
  | 'emailTaken'
  | 'passwordTooShort'
  | 'invalidEmail'
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
  USER_ALREADY_EXISTS: 'emailTaken',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'emailTaken',
  PASSWORD_TOO_SHORT: 'passwordTooShort',
  INVALID_EMAIL: 'invalidEmail',
};

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
  signIn: (input: SignInInput) => post('/sign-in/email', input),
  signUp: (input: SignUpInput) => post('/sign-up/email', input),
  signOut: () => post('/sign-out'),
};
