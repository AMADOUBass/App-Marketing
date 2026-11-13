import { signInSchema } from '@ponctua/contracts';
import { Button, Card, CardContent, CardDescription, CardHeader } from '@ponctua/ui';
import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type SubmitEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField, focusFirstInvalid } from '../components/form-field';
import { OutcomePanel, textLinkClass } from '../components/outcome-panel';
import { AuthError, authApi } from '../lib/auth';

const emailSchema = signInSchema.shape.email;

export function ForgotPasswordPage() {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [invalid, setInvalid] = useState(false);
  const request = useMutation({ mutationFn: authApi.requestPasswordReset });

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const parsed = emailSchema.safeParse(email.trim());
    if (!parsed.success) {
      setInvalid(true);
      queueMicrotask(() => {
        focusFirstInvalid(form);
      });
      return;
    }
    setInvalid(false);
    request.mutate(parsed.data);
  }

  const tooMany = request.error instanceof AuthError && request.error.kind === 'tooManyAttempts';

  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold">{t('forgotPassword.title')}</h1>
      {request.isSuccess ? (
        // Same words whether or not the address has an account (the server answers the same too).
        <OutcomePanel title={t('forgotPassword.sent.title')}>
          <p>{t('forgotPassword.sent.body', { email: request.variables })}</p>
          <p className="text-muted-foreground">{t('forgotPassword.sent.help')}</p>
          <p>
            <Link to="/login" className={textLinkClass}>
              {t('forgotPassword.backToSignIn')}
            </Link>
          </p>
        </OutcomePanel>
      ) : (
        <Card>
          <CardHeader>
            <CardDescription>{t('forgotPassword.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <form noValidate onSubmit={onSubmit} className="grid gap-4">
              <FormField
                label={t('auth.email')}
                name="email"
                type="email"
                autoComplete="email"
                value={email}
                error={invalid ? t('auth.errors.emailInvalid') : undefined}
                onChange={(event) => {
                  setEmail(event.target.value);
                }}
              />
              {request.isError && (
                <p role="alert" className="text-sm font-medium text-destructive">
                  {t(tooMany ? 'auth.errors.tooManyAttempts' : 'auth.errors.unknown')}
                </p>
              )}
              <Button type="submit" className="w-fit" disabled={request.isPending}>
                {request.isPending ? t('forgotPassword.submitting') : t('forgotPassword.submit')}
              </Button>
            </form>
            <p className="mt-6 text-sm">
              <Link to="/login" className={textLinkClass}>
                {t('forgotPassword.backToSignIn')}
              </Link>
            </p>
          </CardContent>
        </Card>
      )}
    </>
  );
}
