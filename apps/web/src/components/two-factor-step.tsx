import { Button, Card, CardContent, CardDescription, CardHeader } from '@ponctua/ui';
import { useMutation } from '@tanstack/react-query';
import { type SubmitEvent, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthError, authApi } from '../lib/auth';
import { FormField, focusFirstInvalid } from './form-field';

const TOTP_PATTERN = /^\d{6}$/;
const BACKUP_PATTERN = /^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$/;

/**
 * Second step of sign-in when two-factor authentication is on: the password was right, but the
 * session opens only once a code from the authenticator app (or a backup code) is checked.
 */
export function TwoFactorStep({
  onSignedIn,
  onRestart,
}: {
  onSignedIn: () => Promise<void>;
  /** The 10-minute window is over or too many wrong codes: back to the password. */
  onRestart: () => void;
}) {
  const { t } = useTranslation();
  const [useBackup, setUseBackup] = useState(false);
  const [code, setCode] = useState('');
  const [trustDevice, setTrustDevice] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const trustId = useId();
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  const verify = useMutation({
    mutationFn: (value: string) =>
      useBackup
        ? authApi.twoFactor.verifyBackupCode(value, trustDevice)
        : authApi.twoFactor.verifyTotp(value, trustDevice),
    onSuccess: onSignedIn,
  });

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const value = code.replace(/\s/g, '');
    if (!(useBackup ? BACKUP_PATTERN : TOTP_PATTERN).test(value)) {
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
    <Card>
      <CardHeader>
        <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold outline-none">
          {t('twoFactor.signIn.title')}
        </h2>
        <CardDescription>
          {useBackup ? t('twoFactor.signIn.backupDescription') : t('twoFactor.signIn.description')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form noValidate onSubmit={onSubmit} className="grid gap-4">
          <FormField
            key={useBackup ? 'backup' : 'totp'}
            label={useBackup ? t('twoFactor.backupCodeLabel') : t('twoFactor.codeLabel')}
            name="code"
            autoComplete={useBackup ? 'off' : 'one-time-code'}
            inputMode={useBackup ? 'text' : 'numeric'}
            spellCheck={false}
            value={code}
            error={
              invalid
                ? useBackup
                  ? t('twoFactor.errors.backupFormat')
                  : t('twoFactor.errors.codeFormat')
                : undefined
            }
            onChange={(event) => {
              setCode(event.target.value);
            }}
          />
          <div className="flex items-center gap-2">
            <input
              id={trustId}
              type="checkbox"
              className="size-4 accent-primary"
              checked={trustDevice}
              onChange={(event) => {
                setTrustDevice(event.target.checked);
              }}
            />
            <label htmlFor={trustId} className="text-sm">
              {t('twoFactor.signIn.trustDevice')}
            </label>
          </div>
          {verify.isError && (
            <div role="alert" className="grid justify-items-start gap-2">
              <p className="text-sm font-medium text-destructive">{t(`auth.errors.${failure}`)}</p>
              {failure === 'codeExpired' && (
                <Button type="button" variant="outline" size="sm" onClick={onRestart}>
                  {t('twoFactor.signIn.restart')}
                </Button>
              )}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-4">
            <Button type="submit" disabled={verify.isPending}>
              {verify.isPending ? t('twoFactor.signIn.verifying') : t('twoFactor.signIn.verify')}
            </Button>
            <Button
              type="button"
              variant="link"
              className="px-0"
              onClick={() => {
                setUseBackup((current) => !current);
                setCode('');
                setInvalid(false);
                verify.reset();
              }}
            >
              {useBackup ? t('twoFactor.signIn.useApp') : t('twoFactor.signIn.useBackup')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
