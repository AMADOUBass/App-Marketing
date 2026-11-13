import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@ponctua/contracts';
import { Button, Card, CardContent, CardDescription, CardHeader } from '@ponctua/ui';
import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { type SubmitEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField, focusFirstInvalid } from '../components/form-field';
import { OutcomePanel, textLinkClass } from '../components/outcome-panel';
import { AuthError, authApi } from '../lib/auth';

/**
 * Reached from the emailed link: the API redirects here with ?token= (or ?error= when the link is
 * invalid or expired). The token is kept in memory and removed from the address bar at once, so it
 * does not stay in the history or leak through a copied URL.
 */
export function ResetPasswordPage({ token, error }: { token?: string; error?: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [resetToken] = useState(token);
  const [password, setPassword] = useState('');
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    if (token) void navigate({ to: '/reset-password', search: {}, replace: true });
  }, [token, navigate]);

  const reset = useMutation({
    mutationFn: (newPassword: string) => authApi.resetPassword(resetToken ?? '', newPassword),
  });

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
      setInvalid(true);
      queueMicrotask(() => {
        focusFirstInvalid(form);
      });
      return;
    }
    setInvalid(false);
    reset.mutate(password);
  }

  const failure = reset.error instanceof AuthError ? reset.error.kind : 'unknown';
  const linkUnusable = Boolean(error) || !resetToken || failure === 'invalidToken';

  if (reset.isSuccess) {
    return (
      <>
        <h1 className="mb-6 text-2xl font-semibold">{t('resetPassword.title')}</h1>
        <OutcomePanel title={t('resetPassword.done.title')}>
          <p>{t('resetPassword.done.body')}</p>
          <p>
            <Link to="/login" className={textLinkClass}>
              {t('login.submit')}
            </Link>
          </p>
        </OutcomePanel>
      </>
    );
  }

  if (linkUnusable) {
    return (
      <>
        <h1 className="mb-6 text-2xl font-semibold">{t('resetPassword.title')}</h1>
        <OutcomePanel title={t('resetPassword.invalid.title')} tone="error">
          <p>{t('resetPassword.invalid.body')}</p>
          <p>
            <Link to="/forgot-password" className={textLinkClass}>
              {t('resetPassword.invalid.again')}
            </Link>
          </p>
        </OutcomePanel>
      </>
    );
  }

  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold">{t('resetPassword.title')}</h1>
      <Card>
        <CardHeader>
          <CardDescription>{t('resetPassword.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form noValidate onSubmit={onSubmit} className="grid gap-4">
            <FormField
              label={t('resetPassword.newPassword')}
              name="newPassword"
              type="password"
              autoComplete="new-password"
              hint={t('auth.passwordHint', { count: PASSWORD_MIN_LENGTH })}
              error={
                invalid
                  ? t('auth.errors.passwordTooShort', { count: PASSWORD_MIN_LENGTH })
                  : undefined
              }
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
            />
            {reset.isError && (
              <p role="alert" className="text-sm font-medium text-destructive">
                {t(`auth.errors.${failure}`, { count: PASSWORD_MIN_LENGTH })}
              </p>
            )}
            <Button type="submit" className="w-fit" disabled={reset.isPending}>
              {reset.isPending ? t('resetPassword.submitting') : t('resetPassword.submit')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </>
  );
}
