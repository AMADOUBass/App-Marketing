import { instagramConnectResponseSchema, socialAccountListSchema } from '@ponctua/contracts';
import { Button, Card, CardContent } from '@ponctua/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { MainNav } from '../components/main-nav';
import { ApiError, apiGet } from '../lib/api';
import { externalNavigation } from '../lib/navigation';
import { useSession } from '../lib/session';

export const CONNECT_RESULTS = [
  'connected',
  'cancelled',
  'invalid_state',
  'no_account',
  'failed',
] as const;
export type ConnectResult = (typeof CONNECT_RESULTS)[number];

export function AccountsPage({ result }: { result: ConnectResult | undefined }) {
  const { t } = useTranslation();
  const organizationId = useSession((state) => state.organizationId) ?? '';

  const accounts = useQuery({
    queryKey: ['social-accounts', organizationId],
    queryFn: ({ signal }) =>
      apiGet('/social-accounts', socialAccountListSchema, organizationId, signal),
  });

  // The server builds Meta's login URL (signed state, configuration); the browser only follows it.
  const connect = useMutation({
    mutationFn: () =>
      apiGet('/integrations/instagram/connect', instagramConnectResponseSchema, organizationId),
    onSuccess: ({ loginUrl }) => {
      externalNavigation.go(loginUrl);
    },
  });
  const notConfigured = connect.error instanceof ApiError && connect.error.status === 503;
  const items = accounts.data?.items ?? [];

  return (
    <>
      <MainNav />
      <h1 className="mb-6 text-2xl font-semibold">{t('accounts.title')}</h1>

      {result && (
        <p
          role={result === 'connected' ? 'status' : 'alert'}
          className={`mb-6 rounded-md border px-4 py-3 text-sm ${result === 'connected' ? '' : 'border-destructive text-destructive'}`}
        >
          {t(`accounts.result.${result}`)}
        </p>
      )}

      <div aria-live="polite" aria-busy={accounts.isPending}>
        {accounts.isPending && <p>{t('accounts.loading')}</p>}
        {accounts.isError && <p role="alert">{t('accounts.error')}</p>}
        {accounts.isSuccess && items.length === 0 && <p>{t('accounts.empty')}</p>}
      </div>

      {items.length > 0 && (
        <ul className="mb-6 grid gap-3">
          {items.map((account) => (
            <li key={account.id}>
              <Card className="py-4">
                <CardContent className="flex items-center justify-between gap-4">
                  <span>
                    <span className="font-medium">@{account.displayName}</span>{' '}
                    <span className="text-sm text-muted-foreground">({account.platform})</span>
                  </span>
                  <span className="text-sm">
                    {account.connected ? t('accounts.connected') : t('accounts.notConnected')}
                  </span>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <div className="grid justify-items-start gap-3">
        <Button
          disabled={connect.isPending || connect.isSuccess}
          onClick={() => {
            connect.mutate();
          }}
        >
          {connect.isPending || connect.isSuccess
            ? t('accounts.redirecting')
            : t('accounts.connectInstagram')}
        </Button>
        {connect.isError && (
          <p role="alert" className="text-sm text-destructive">
            {notConfigured ? t('accounts.notConfigured') : t('accounts.connectError')}
          </p>
        )}
      </div>
    </>
  );
}
