import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

interface SessionState {
  /** Organization chosen on the dev sign-in page (ADR 003). Replaced by a real session later. */
  organizationId: string | null;
  signIn: (organizationId: string) => void;
  signOut: () => void;
}

/** Per-tab session (sessionStorage): closing the tab forgets the organization. */
export const useSession = create<SessionState>()(
  persist(
    (set) => ({
      organizationId: null,
      signIn: (organizationId) => {
        set({ organizationId });
      },
      signOut: () => {
        set({ organizationId: null });
      },
    }),
    { name: 'app-session', storage: createJSONStorage(() => sessionStorage) },
  ),
);
