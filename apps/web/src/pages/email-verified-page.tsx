import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { OutcomePanel, textLinkClass } from '../components/outcome-panel';
import { meQuery } from '../lib/me';

/**
 * Where the emailed verification link lands. On success the API has just opened the session
 * (cookie), so the cached "not signed in" answer is dropped; "Continue" then picks the next page
 * (create an organization for a new account).
 */
export function EmailVerifiedPage({ error }: { error?: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!error) queryClient.removeQueries({ queryKey: meQuery.queryKey });
  }, [error, queryClient]);

  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold">{t('emailVerified.title')}</h1>
      {error ? (
        <OutcomePanel title={t('emailVerified.invalid.title')} tone="error">
          <p>{t('emailVerified.invalid.body')}</p>
          <p>
            <Link to="/login" className={textLinkClass}>
              {t('login.submit')}
            </Link>
          </p>
        </OutcomePanel>
      ) : (
        <OutcomePanel title={t('emailVerified.done.title')}>
          <p>{t('emailVerified.done.body')}</p>
          <p>
            <Link to="/" className={textLinkClass}>
              {t('emailVerified.done.continue')}
            </Link>
          </p>
        </OutcomePanel>
      )}
    </>
  );
}
