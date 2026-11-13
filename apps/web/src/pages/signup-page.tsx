import { PASSWORD_MIN_LENGTH, signUpSchema } from '@ponctua/contracts';
import { Button, Card, CardContent, CardDescription, CardHeader } from '@ponctua/ui';
import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ChangeEvent, type SubmitEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField, focusFirstInvalid } from '../components/form-field';
import { OutcomePanel, textLinkClass } from '../components/outcome-panel';
import { AuthError, authApi } from '../lib/auth';

const FIELDS = ['name', 'email', 'password'] as const;
type Field = (typeof FIELDS)[number];

export function SignUpPage() {
  const { t } = useTranslation();
  const [values, setValues] = useState<Record<Field, string>>({
    name: '',
    email: '',
    password: '',
  });
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});

  // No session yet: the emailed link opens it (ADR 009). The answer is the same for an address that
  // already has an account, so the next screen says the same thing in both cases.
  const signUp = useMutation({ mutationFn: authApi.signUp });

  const messages: Record<Field, string> = {
    name: t('auth.errors.nameRequired'),
    email: t('auth.errors.emailInvalid'),
    password: t('auth.errors.passwordTooShort', { count: PASSWORD_MIN_LENGTH }),
  };

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const parsed = signUpSchema.safeParse({ ...values, email: values.email.trim() });
    if (!parsed.success) {
      const invalid = new Set(parsed.error.issues.map((issue) => issue.path[0]));
      setErrors(
        Object.fromEntries(
          FIELDS.filter((field) => invalid.has(field)).map((field) => [field, messages[field]]),
        ),
      );
      queueMicrotask(() => {
        focusFirstInvalid(form);
      });
      return;
    }
    setErrors({});
    signUp.mutate(parsed.data);
  }

  const field = (name: Field) => ({
    name,
    value: values[name],
    error: errors[name],
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      setValues((current) => ({ ...current, [name]: event.target.value }));
    },
  });
  const failure = signUp.error instanceof AuthError ? signUp.error.kind : 'unknown';

  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold">{t('signup.title')}</h1>
      {signUp.isSuccess ? (
        <OutcomePanel title={t('signup.checkEmail.title')}>
          <p>{t('signup.checkEmail.body', { email: signUp.variables.email })}</p>
          <p className="text-muted-foreground">{t('signup.checkEmail.help')}</p>
          <p>
            <Link to="/login" className={textLinkClass}>
              {t('signup.signInLink')}
            </Link>
          </p>
        </OutcomePanel>
      ) : (
        <Card>
          <CardHeader>
            <CardDescription>{t('signup.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <form noValidate onSubmit={onSubmit} className="grid gap-4">
              <FormField label={t('auth.name')} autoComplete="name" {...field('name')} />
              <FormField
                label={t('auth.email')}
                type="email"
                autoComplete="email"
                {...field('email')}
              />
              <FormField
                label={t('auth.password')}
                type="password"
                autoComplete="new-password"
                hint={t('auth.passwordHint', { count: PASSWORD_MIN_LENGTH })}
                {...field('password')}
              />
              {signUp.isError && (
                <p role="alert" className="text-sm font-medium text-destructive">
                  {t(`auth.errors.${failure}`, { count: PASSWORD_MIN_LENGTH })}
                </p>
              )}
              <Button type="submit" className="w-fit" disabled={signUp.isPending}>
                {signUp.isPending ? t('signup.submitting') : t('signup.submit')}
              </Button>
            </form>
            <p className="mt-6 text-sm">
              {t('signup.haveAccount')}{' '}
              <Link to="/login" className={textLinkClass}>
                {t('signup.signInLink')}
              </Link>
            </p>
          </CardContent>
        </Card>
      )}
    </>
  );
}
