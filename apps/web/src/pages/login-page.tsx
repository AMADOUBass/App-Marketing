import { signInSchema } from '@ponctua/contracts';
import { Button, Card, CardContent, CardDescription, CardHeader } from '@ponctua/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { type SubmitEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField, focusFirstInvalid } from '../components/form-field';
import { TwoFactorStep } from '../components/two-factor-step';
import { AuthError, authApi } from '../lib/auth';
import { meQuery } from '../lib/me';
import { passkeys } from '../lib/passkeys';

type Field = 'email' | 'password';

export function LoginPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  /** Two-factor on: the password was right, a code is still needed before any session. */
  const [needsCode, setNeedsCode] = useState(false);

  async function signedIn() {
    // The cached "no session" answer is now wrong: the home route reloads /me and picks the page.
    queryClient.removeQueries({ queryKey: meQuery.queryKey });
    await navigate({ to: '/' });
  }

  const passkeySignIn = useMutation({
    mutationFn: () => passkeys.signIn(),
    onSuccess: signedIn,
  });
  const passkeyFailure =
    passkeySignIn.error instanceof AuthError ? passkeySignIn.error.kind : 'unknown';

  // Browsers with conditional UI list this site's passkeys in the email field's suggestions: picking
  // one signs in, without typing anything. Silent until the user picks one.
  useEffect(() => {
    if (needsCode || !passkeys.supported()) return;
    let active = true;
    void passkeys.autofillSupported().then((available) => {
      if (!available || !active) return;
      passkeys.signIn(true).then(
        () => {
          queryClient.removeQueries({ queryKey: meQuery.queryKey });
          void navigate({ to: '/' });
        },
        () => undefined, // Cancelled, or replaced by the button's request.
      );
    });
    return () => {
      active = false;
      passkeys.cancelPending();
    };
  }, [needsCode, queryClient, navigate]);

  const signIn = useMutation({
    mutationFn: authApi.signIn,
    onSuccess: async ({ twoFactor }) => {
      if (twoFactor) {
        setPassword('');
        setNeedsCode(true);
        return;
      }
      await signedIn();
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
      {needsCode ? (
        <TwoFactorStep
          onSignedIn={signedIn}
          onRestart={() => {
            signIn.reset();
            setNeedsCode(false);
          }}
        />
      ) : (
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
                // "webauthn": lets the browser offer passkeys in this field's suggestions.
                autoComplete="username webauthn"
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
              <div className="flex flex-wrap items-center gap-4">
                <Button type="submit" disabled={signIn.isPending}>
                  {signIn.isPending ? t('login.submitting') : t('login.submit')}
                </Button>
                <Link
                  to="/forgot-password"
                  className="text-sm font-medium underline underline-offset-4"
                >
                  {t('login.forgotPassword')}
                </Link>
              </div>
            </form>
            {passkeys.supported() && (
              <div className="mt-6 grid gap-3 border-t pt-6">
                <Button
                  type="button"
                  variant="outline"
                  className="w-fit"
                  disabled={passkeySignIn.isPending}
                  onClick={() => {
                    passkeySignIn.mutate();
                  }}
                >
                  {t('passkeys.signIn')}
                </Button>
                {passkeySignIn.isError && passkeyFailure !== 'passkeyCancelled' && (
                  <p role="alert" className="text-sm font-medium text-destructive">
                    {t(`auth.errors.${passkeyFailure}`)}
                  </p>
                )}
              </div>
            )}
            <p className="mt-6 text-sm">
              {t('login.noAccount')}{' '}
              <Link to="/signup" className="font-medium underline underline-offset-4">
                {t('login.signUpLink')}
              </Link>
            </p>
          </CardContent>
        </Card>
      )}
    </>
  );
}
