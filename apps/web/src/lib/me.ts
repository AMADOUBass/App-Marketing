import { type MeResponse, meResponseSchema } from '@ponctua/contracts';
import { type QueryClient, queryOptions } from '@tanstack/react-query';
import { ApiError, apiRequest } from './api';
import { useSession } from './session';

/** The signed-in user and their organizations; null when there is no valid session. */
export const meQuery = queryOptions({
  queryKey: ['me'],
  queryFn: async ({ signal }): Promise<MeResponse | null> => {
    try {
      return await apiRequest('/me', meResponseSchema, { signal });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return null;
      throw error;
    }
  },
  staleTime: 60_000,
});

/**
 * Switching organization (or user) drops every cached response: data of the previous organization
 * must never be shown, even for an instant, under the new one.
 */
export function enterOrganization(queryClient: QueryClient, organizationId: string): void {
  useSession.getState().selectOrganization(organizationId);
  queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== meQuery.queryKey[0] });
}

/** Forgets everything about the previous session (after sign-out, or when the API answers 401). */
export function forgetSession(queryClient: QueryClient): void {
  useSession.getState().clear();
  queryClient.clear();
}
