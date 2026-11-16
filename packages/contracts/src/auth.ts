import { z } from 'zod';

/** Shared by Better Auth's configuration (apps/api) and the web forms, so both enforce the same rule. */
export const PASSWORD_MIN_LENGTH = 12;
/** Better Auth's default maximum; long passphrases stay allowed. */
export const PASSWORD_MAX_LENGTH = 128;

export const signInSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});
export type SignInInput = z.infer<typeof signInSchema>;

export const signUpSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.email(),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
});
export type SignUpInput = z.infer<typeof signUpSchema>;

/** Better Auth answers the web reads (apps/web/src/lib/auth.ts). */
export const signInResultSchema = z.object({ twoFactorRedirect: z.boolean().optional() });
export const twoFactorEnableResultSchema = z.object({
  totpURI: z.string().startsWith('otpauth://'),
  backupCodes: z.array(z.string()),
});
export const backupCodesResultSchema = z.object({ backupCodes: z.array(z.string()) });
