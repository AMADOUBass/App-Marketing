import { Button, Card, CardContent, CardDescription, CardHeader, Input, Label } from '@app/ui';
import { useNavigate } from '@tanstack/react-router';
import { type SubmitEvent, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { useSession } from '../lib/session';

const organizationIdSchema = z.uuid();

/** Development sign-in (ADR 003): pick an organization. Replaced by Better Auth. */
export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const signIn = useSession((state) => state.signIn);
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = organizationIdSchema.safeParse(value.trim());
    if (!parsed.success) {
      setInvalid(true);
      return;
    }
    signIn(parsed.data);
    void navigate({ to: '/posts' });
  }

  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold">{t('login.title')}</h1>
      <Card>
        <CardHeader>
          <p className="w-fit rounded-md bg-secondary px-2 py-0.5 text-xs font-medium">
            {t('app.devMode')}
          </p>
          <CardDescription>{t('login.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form noValidate onSubmit={onSubmit} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor={inputId}>{t('login.organizationLabel')}</Label>
              <Input
                id={inputId}
                name="organizationId"
                autoComplete="off"
                spellCheck={false}
                value={value}
                aria-invalid={invalid}
                aria-describedby={invalid ? `${hintId} ${errorId}` : hintId}
                onChange={(event) => {
                  setValue(event.target.value);
                  setInvalid(false);
                }}
              />
              <p id={hintId} className="text-sm text-muted-foreground">
                {t('login.organizationHint')}
              </p>
              {invalid && (
                <p id={errorId} role="alert" className="text-sm font-medium text-destructive">
                  {t('login.invalidOrganization')}
                </p>
              )}
            </div>
            <Button type="submit" className="w-fit">
              {t('login.submit')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </>
  );
}
