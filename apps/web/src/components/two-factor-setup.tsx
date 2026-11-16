import { Button } from '@ponctua/ui';
import { useMutation } from '@tanstack/react-query';
import { type SubmitEvent, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { renderSVG } from 'uqr';
import { AuthError, authApi } from '../lib/auth';
import { FormField, focusFirstInvalid } from './form-field';

/** The key typed by hand when the QR code cannot be scanned, in groups of 4 for readability. */
function manualKey(totpUri: string): string {
  const secret = new URL(totpUri).searchParams.get('secret') ?? '';
  return secret.match(/.{1,4}/g)?.join(' ') ?? secret;
}

/**
 * Scan (or type the key), then enter a first code: two-factor authentication is on only once that
 * code is accepted. The QR code is drawn in the browser; the secret goes to no third party.
 */
export function TwoFactorSetup({
  totpUri,
  onEnabled,
  onCancel,
}: {
  totpUri: string;
  onEnabled: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [invalid, setInvalid] = useState(false);
  const qr = useMemo(
    () =>
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderSVG(totpUri, { border: 2 }))}`,
    [totpUri],
  );
  const verify = useMutation({
    mutationFn: (value: string) => authApi.twoFactor.verifyTotp(value),
    onSuccess: onEnabled,
  });

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const value = code.replace(/\s/g, '');
    if (!/^\d{6}$/.test(value)) {
      setInvalid(true);
      queueMicrotask(() => {
        focusFirstInvalid(form);
      });
      return;
    }
    setInvalid(false);
    verify.mutate(value);
  }

  const failure = verify.error instanceof AuthError ? verify.error.kind : 'unknown';

  return (
    <div className="grid gap-4">
      <ol className="grid list-decimal gap-2 pl-5 text-sm">
        <li>{t('twoFactor.setup.step1')}</li>
        <li>{t('twoFactor.setup.step2')}</li>
        <li>{t('twoFactor.setup.step3')}</li>
      </ol>
      <img
        src={qr}
        alt={t('twoFactor.setup.qrAlt')}
        width={192}
        height={192}
        className="rounded-md border bg-white"
      />
      <div className="grid gap-1 text-sm">
        <p>{t('twoFactor.setup.manualKey')}</p>
        <code className="w-fit rounded bg-muted px-2 py-1 font-mono tracking-wider select-all">
          {manualKey(totpUri)}
        </code>
      </div>
      <form noValidate onSubmit={onSubmit} className="grid gap-4">
        <FormField
          label={t('twoFactor.codeLabel')}
          name="code"
          autoComplete="one-time-code"
          inputMode="numeric"
          value={code}
          error={invalid ? t('twoFactor.errors.codeFormat') : undefined}
          onChange={(event) => {
            setCode(event.target.value);
          }}
        />
        {verify.isError && (
          <p role="alert" className="text-sm font-medium text-destructive">
            {t(`auth.errors.${failure}`)}
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={verify.isPending}>
            {t('twoFactor.setup.confirm')}
          </Button>
          <Button type="button" variant="outline" onClick={onCancel}>
            {t('security.cancel')}
          </Button>
        </div>
      </form>
    </div>
  );
}
