import { z } from 'zod';

export const platformSchema = z.enum([
  'facebook',
  'instagram',
  'threads',
  'youtube',
  'linkedin',
  'tiktok',
]);

/** A connected social account as the web app sees it. Never carries tokens (rule 3). */
export const socialAccountSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  platform: platformSchema,
  displayName: z.string(),
  externalAccountId: z.string(),
  /** A sealed credential exists for this account. */
  connected: z.boolean(),
});
export type SocialAccountDto = z.infer<typeof socialAccountSchema>;

export const socialAccountListSchema = z.object({ items: z.array(socialAccountSchema) });
export type SocialAccountList = z.infer<typeof socialAccountListSchema>;

export const instagramConnectQuerySchema = z.object({ workspaceId: z.uuid().optional() });
export type InstagramConnectQuery = z.infer<typeof instagramConnectQuerySchema>;

export const instagramConnectResponseSchema = z.object({ loginUrl: z.url() });
export type InstagramConnectResponse = z.infer<typeof instagramConnectResponseSchema>;

/** Query string Meta sends back to the redirect URL (success: code + state; refusal: error fields). */
export const oauthCallbackQuerySchema = z.looseObject({
  code: z.string().max(4096).optional(),
  state: z.string().max(1024).optional(),
  error: z.string().max(256).optional(),
});
export type OauthCallbackQuery = z.infer<typeof oauthCallbackQuerySchema>;
