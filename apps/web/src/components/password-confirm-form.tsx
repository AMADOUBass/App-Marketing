import { Button } from '@ponctua/ui';
import { useMutation } from '@tanstack/react-query';
import { type SubmitEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthError } from '../lib/auth';
import { FormField, focusFirstInvalid } from './form-field';

/** Sensitive changes ask for the password again, even in an open session. */
export function PasswordConfirmForm({
  submitLabel,
  description,
  onConfirm,
  onCancel,
}: {
  submitLabel: string;
  description: string;
  onConfirm: (password: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [missing, setMissing] = useState(false);
  const confirm = useMutation({ mutationFn: onConfirm });

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!password) {
      setMissing(true);
      queueMicrotask(() => {
        focusFirstInvalid(form);
      });
      return;
    }
    setMissing(false);
    confirm.mutate(password);
  }

  const failure = confirm.error instanceof AuthError ? confirm.error.kind : 'unknown';

  return (
    <form noValidate onSubmit={onSubmit} className="grid gap-4">
      <p className="text-sm">{description}</p>
      <FormField
        label={t('security.confirmPassword')}
        name="password"
        type="password"
        autoComplete="current-password"
        autoFocus
        value={password}
        error={missing ? t('auth.errors.passwordRequired') : undefined}
        onChange={(event) => {
          setPassword(event.target.value);
        }}
      />
      {confirm.isError && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {t(`auth.errors.${failure}`)}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={confirm.isPending}>
          {submitLabel}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('security.cancel')}
        </Button>
      </div>
    </form>
  );
}
