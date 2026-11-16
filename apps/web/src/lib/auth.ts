import {
  backupCodesResultSchema,
  type SignInInput,
  type SignUpInput,
  signInResultSchema,
  twoFactorEnableResultSchema,
} from '@ponctua/contracts';

export type AuthErrorKind =
  | 'invalidCredentials'
  | 'invalidPassword'
  | 'emailNotVerified'
  | 'passwordTooShort'
  | 'invalidEmail'
  | 'invalidToken'
  | 'invalidCode'
  | 'codeExpired'
  | 'tooManyAttempts'
  | 'sessionNotFresh'
  | 'userVerificationRequired'
  | 'passkeyFailed'
  | 'passkeyCancelled'
  | 'unknown';

export class AuthError extends Error {
  override readonly name = 'AuthError';

  constructor(readonly kind: AuthErrorKind) {
    super(kind);
  }
}

/** Better Auth error codes (checked by apps/api/test/*.test.ts) mapped to messages we translate. */
const ERROR_KINDS: Record<string, AuthErrorKind> = {
  INVALID_EMAIL_OR_PASSWORD: 'invalidCredentials',
  INVALID_PASSWORD: 'invalidPassword',
  EMAIL_NOT_VERIFIED: 'emailNotVerified',
  PASSWORD_TOO_SHORT: 'passwordTooShort',
  INVALID_EMAIL: 'invalidEmail',
  INVALID_TOKEN: 'invalidToken',
  INVALID_CODE: 'invalidCode',
  INVALID_BACKUP_CODE: 'invalidCode',
  // The 10-minute window after the password is over, or too many wrong codes: start again.
  INVALID_TWO_FACTOR_COOKIE: 'codeExpired',
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: 'codeExpired',
  ACCOUNT_TEMPORARILY_LOCKED: 'tooManyAttempts',
  // Passkeys (ADR 011).
  SESSION_NOT_FRESH: 'sessionNotFresh',
  USER_VERIFICATION_REQUIRED: 'userVerificationRequired',
  PASSKEY_NOT_FOUND: 'passkeyFailed',
  AUTHENTICATION_FAILED: 'passkeyFailed',
  FAILED_TO_VERIFY_REGISTRATION: 'passkeyFailed',
};

/** Web pages the emailed links come back to (same paths as the API's EMAIL_VERIFIED_PATH…). */
export const EMAIL_VERIFIED_PATH = '/email-verified';
export const RESET_PASSWORD_PATH = '/reset-password';

/**
 * Better Auth endpoints. The session is an httpOnly cookie set by the server: nothing to store here,
 * and the API strips the session token from JSON bodies (ADR 008).
 */
export async function authRequest(
  method: 'GET' | 'POST',
  path: string,
  body: object = {},
): Promise<unknown> {
  const response = await fetch(`/api/auth${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
    },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
  if (response.ok) return response.json().catch(() => null);
  if (response.status === 429) throw new AuthError('tooManyAttempts');

  const error: unknown = await response.json().catch(() => null);
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : '';
  throw new AuthError(ERROR_KINDS[code] ?? 'unknown');
}

const post = (path: string, body: object = {}) => authRequest('POST', path, body);

export interface TwoFactorSetup {
  /** otpauth:// URI for the authenticator app (QR code). Kept in memory only, never stored. */
  totpUri: string;
  backupCodes: string[];
}

export const authApi = {
  /**
   * `twoFactor: true`: the password was right but the session opens only after the code
   * (verifyTotp / verifyBackupCode). An unverified address gets a fresh link (emailNotVerified).
   */
  signIn: async (input: SignInInput): Promise<{ twoFactor: boolean }> => {
    const result = signInResultSchema.safeParse(
      await post('/sign-in/email', { ...input, callbackURL: EMAIL_VERIFIED_PATH }),
    );
    return { twoFactor: result.success && result.data.twoFactorRedirect === true };
  },
  /**
   * Opens no session: the emailed link does. Same answer whether or not the address already has an
   * account (the owner is warned by email instead).
   */
  signUp: async (input: SignUpInput): Promise<void> => {
    await post('/sign-up/email', { ...input, callbackURL: EMAIL_VERIFIED_PATH });
  },
  signOut: async (): Promise<void> => {
    await post('/sign-out');
  },
  /** Same answer for unknown addresses. */
  requestPasswordReset: async (email: string): Promise<void> => {
    await post('/request-password-reset', { email, redirectTo: RESET_PASSWORD_PATH });
  },
  /** Signs out every session of the account. */
  resetPassword: async (token: string, newPassword: string): Promise<void> => {
    await post('/reset-password', { token, newPassword });
  },
  /** Signed in: the other sessions are signed out; the owner is told by email. */
  changePassword: async (currentPassword: string, newPassword: string): Promise<void> => {
    await post('/change-password', { currentPassword, newPassword, revokeOtherSessions: true });
  },

  twoFactor: {
    /** Starts the setup; it is on only after a first valid code (verifyTotp). */
    enable: async (password: string): Promise<TwoFactorSetup> => {
      const { totpURI, backupCodes } = twoFactorEnableResultSchema.parse(
        await post('/two-factor/enable', { password }),
      );
      return { totpUri: totpURI, backupCodes };
    },
    /** Confirms the setup (signed in) or completes a sign-in (after the password). */
    verifyTotp: async (code: string, trustDevice = false): Promise<void> => {
      await post('/two-factor/verify-totp', { code, trustDevice });
    },
    verifyBackupCode: async (code: string, trustDevice = false): Promise<void> => {
      await post('/two-factor/verify-backup-code', { code, trustDevice });
    },
    disable: async (password: string): Promise<void> => {
      await post('/two-factor/disable', { password });
    },
    /** New codes replace the old ones, which stop working. */
    regenerateBackupCodes: async (password: string): Promise<string[]> =>
      backupCodesResultSchema.parse(await post('/two-factor/generate-backup-codes', { password }))
        .backupCodes,
  },
};
