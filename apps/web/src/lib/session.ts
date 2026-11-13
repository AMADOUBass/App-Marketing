import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

interface SessionState {
  /**
   * Organization the user is working in. Only a preference: the API checks membership on every
   * request, and the router re-checks it against /me on each navigation.
   */
  organizationId: string | null;
  selectOrganization: (organizationId: string) => void;
  clear: () => void;
}

/** Per-tab (sessionStorage): two tabs can work in two organizations. */
export const useSession = create<SessionState>()(
  persist(
    (set) => ({
      organizationId: null,
      selectOrganization: (organizationId) => {
        set({ organizationId });
      },
      clear: () => {
        set({ organizationId: null });
      },
    }),
    { name: 'ponctua-organization', storage: createJSONStorage(() => sessionStorage) },
  ),
);
