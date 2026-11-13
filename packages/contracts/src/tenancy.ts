import { z } from 'zod';

export const organizationRoleSchema = z.enum(['owner', 'admin', 'member']);

export const userOrganizationSchema = z.object({
  organizationId: z.uuid(),
  name: z.string(),
  role: organizationRoleSchema,
});
export type UserOrganization = z.infer<typeof userOrganizationSchema>;

/** The signed-in user and the organizations they can act for. Never carries tokens or passwords. */
export const meResponseSchema = z.object({
  user: z.object({ id: z.uuid(), name: z.string(), email: z.email() }),
  organizations: z.array(userOrganizationSchema),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

export const createOrganizationSchema = z.strictObject({
  name: z.string().trim().min(2).max(120),
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
