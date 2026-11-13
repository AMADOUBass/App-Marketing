import { signInSchema } from '@ponctua/contracts';
import { Button, Card, CardContent, CardDescription, CardHeader } from '@ponctua/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { type SubmitEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField, focusFirstInvalid } from '../components/form-field';
import { AuthError, authApi } from '../lib/auth';
import { meQuery } from '../lib/me';

type Field = 'email' | 'password';

export function LoginPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});

  const signIn = useMutation({
    mutationFn: authApi.signIn,
    onSuccess: async () => {
      // The cached "no session" answer is now wrong: the home route reloads /me and picks the page.
      queryClient.removeQueries({ queryKey: meQuery.queryKey });
      await navigate({ to: '/' });
    },
  });

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const parsed = signInSchema.safeParse({ email: email.trim(), password });
    if (!parsed.success) {
      const fields = new Set(parsed.error.issues.map((issue) => issue.path[0]));
      setErrors({
        ...(fields.has('email') ? { email: t('auth.errors.emailInvalid') } : {}),
        ...(fields.has('password') ? { password: t('auth.errors.passwordRequired') } : {}),
      });
      queueMicrotask(() => {
        focusFirstInvalid(form);
      });
      return;
    }
    setErrors({});
    signIn.mutate(parsed.data);
  }

  const failure = signIn.error instanceof AuthError ? signIn.error.kind : 'unknown';

  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold">{t('login.title')}</h1>
      <Card>
        <CardHeader>
          <CardDescription>{t('login.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form noValidate onSubmit={onSubmit} className="grid gap-4">
            <FormField
              label={t('auth.email')}
              name="email"
              type="email"
              autoComplete="username"
              value={email}
              error={errors.email}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
            />
            <FormField
              label={t('auth.password')}
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              error={errors.password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
            />
            {signIn.isError && (
              <p role="alert" className="text-sm font-medium text-destructive">
                {t(`auth.errors.${failure}`)}
              </p>
            )}
            <Button type="submit" className="w-fit" disabled={signIn.isPending}>
              {signIn.isPending ? t('login.submitting') : t('login.submit')}
            </Button>
          </form>
          <p className="mt-6 text-sm">
            {t('login.noAccount')}{' '}
            <Link to="/signup" className="font-medium underline underline-offset-4">
              {t('login.signUpLink')}
            </Link>
          </p>
        </CardContent>
      </Card>
    </>
  );
}
