import { Button } from '@ponctua/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Outlet, useNavigate } from '@tanstack/react-router';
import { useEffect, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { authApi } from '../lib/auth';
import { enterOrganization, forgetSession, meQuery } from '../lib/me';
import { useSession } from '../lib/session';
import { MainNav } from './main-nav';

const selectClass =
  'h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

/** Signed-in area: navigation, current organization (switchable) and sign-out. */
export function AppLayout() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const selectId = useId();
  // Loaded by the route guard before this renders.
  const me = useQuery(meQuery).data;
  const organizationId = useSession((state) => state.organizationId);

  // A background refresh of /me found no session (expired or revoked elsewhere): sign in again.
  useEffect(() => {
    if (me !== null) return;
    forgetSession(queryClient);
    void navigate({ to: '/login' });
  }, [me, queryClient, navigate]);

  const signOut = useMutation({
    mutationFn: authApi.signOut,
    onSuccess: async () => {
      forgetSession(queryClient);
      await navigate({ to: '/login' });
    },
  });

  if (!me) return null;
  const current = me.organizations.find((o) => o.organizationId === organizationId);

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 border-b pb-4">
        <MainNav />
        <div className="flex flex-wrap items-center gap-3">
          {me.organizations.length > 1 ? (
            <div className="flex items-center gap-2">
              <label htmlFor={selectId} className="text-sm font-medium">
                {t('session.organizationLabel')}
              </label>
              <select
                id={selectId}
                className={selectClass}
                value={organizationId ?? ''}
                onChange={(event) => {
                  enterOrganization(queryClient, event.target.value);
                  void navigate({ to: '/posts' });
                }}
              >
                {me.organizations.map((organization) => (
                  <option key={organization.organizationId} value={organization.organizationId}>
                    {organization.name}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <p className="flex gap-2 text-sm">
              <span className="text-muted-foreground">{t('session.organizationLabel')}</span>
              <span className="font-medium">{current?.name}</span>
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={signOut.isPending}
            onClick={() => {
              signOut.mutate();
            }}
          >
            {t('session.signOut')}
          </Button>
        </div>
      </div>
      {signOut.isError && (
        <p role="alert" className="mb-6 text-sm font-medium text-destructive">
          {t('session.signOutError')}
        </p>
      )}
      <Outlet />
    </>
  );
}
