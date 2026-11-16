import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@ponctua/contracts';
import { Button, Card, CardContent, CardDescription, CardHeader } from '@ponctua/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type SubmitEvent, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BackupCodes } from '../components/backup-codes';
import { FormField, focusFirstInvalid } from '../components/form-field';
import { PasswordConfirmForm } from '../components/password-confirm-form';
import { TwoFactorSetup } from '../components/two-factor-setup';
import { AuthError, authApi } from '../lib/auth';
import { meQuery } from '../lib/me';

type TwoFactorView =
  | { step: 'idle' }
  | { step: 'confirm'; action: 'enable' | 'disable' | 'regenerate' }
  | { step: 'scan'; totpUri: string; backupCodes: string[] }
  | { step: 'codes'; backupCodes: string[] };

function TwoFactorSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const headingId = useId();
  const enabled = useQuery(meQuery).data?.user.twoFactorEnabled ?? false;
  const [view, setView] = useState<TwoFactorView>({ step: 'idle' });
  const [notice, setNotice] = useState<string | null>(null);
  const idle = () => {
    setView({ step: 'idle' });
  };
  const refreshMe = () => queryClient.invalidateQueries({ queryKey: meQuery.queryKey });

  const confirmations = {
    enable: {
      label: t('twoFactor.enable'),
      run: async (password: string) => {
        const setup = await authApi.twoFactor.enable(password);
        setView({ step: 'scan', ...setup });
      },
    },
    disable: {
      label: t('twoFactor.disable'),
      run: async (password: string) => {
        await authApi.twoFactor.disable(password);
        await refreshMe();
        setNotice(t('twoFactor.disabledNotice'));
        idle();
      },
    },
    regenerate: {
      label: t('twoFactor.regenerate'),
      run: async (password: string) => {
        setView({
          step: 'codes',
          backupCodes: await authApi.twoFactor.regenerateBackupCodes(password),
        });
      },
    },
  };

  return (
    <section aria-labelledby={headingId}>
      <Card>
        <CardHeader>
          <h2 id={headingId} className="text-lg font-semibold">
            {t('twoFactor.title')}
          </h2>
          <CardDescription>{t('twoFactor.description')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <p className="text-sm">
            <span className="font-medium">{t('twoFactor.status')}</span>{' '}
            <span>{enabled ? t('twoFactor.on') : t('twoFactor.off')}</span>
          </p>
          {notice && view.step === 'idle' && (
            <p role="status" className="text-sm">
              {notice}
            </p>
          )}

          {view.step === 'idle' &&
            (enabled ? (
              <div className="flex flex-wrap gap-3">
                <Button
                  variant="outline"
                  onClick={() => {
                    setNotice(null);
                    setView({ step: 'confirm', action: 'regenerate' });
                  }}
                >
                  {t('twoFactor.regenerate')}
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    setNotice(null);
                    setView({ step: 'confirm', action: 'disable' });
                  }}
                >
                  {t('twoFactor.disable')}
                </Button>
              </div>
            ) : (
              <Button
                className="w-fit"
                onClick={() => {
                  setNotice(null);
                  setView({ step: 'confirm', action: 'enable' });
                }}
              >
                {t('twoFactor.enable')}
              </Button>
            ))}

          {view.step === 'confirm' && (
            <PasswordConfirmForm
              description={t(`twoFactor.confirm.${view.action}`)}
              submitLabel={confirmations[view.action].label}
              onConfirm={confirmations[view.action].run}
              onCancel={idle}
            />
          )}

          {view.step === 'scan' && (
            <TwoFactorSetup
              totpUri={view.totpUri}
              onEnabled={() => {
                void refreshMe();
                setView({ step: 'codes', backupCodes: view.backupCodes });
              }}
              onCancel={idle}
            />
          )}

          {view.step === 'codes' && (
            <BackupCodes
              codes={view.backupCodes}
              onDone={() => {
                setNotice(t('twoFactor.enabledNotice'));
                idle();
              }}
            />
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function ChangePasswordSection() {
  const { t } = useTranslation();
  const headingId = useId();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [errors, setErrors] = useState<{ current?: string; next?: string }>({});
  const change = useMutation({
    mutationFn: () => authApi.changePassword(current, next),
    onSuccess: () => {
      setCurrent('');
      setNext('');
    },
  });

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const found = {
      ...(current ? {} : { current: t('auth.errors.passwordRequired') }),
      ...(next.length >= PASSWORD_MIN_LENGTH && next.length <= PASSWORD_MAX_LENGTH
        ? {}
        : { next: t('auth.errors.passwordTooShort', { count: PASSWORD_MIN_LENGTH }) }),
    };
    setErrors(found);
    if (Object.keys(found).length > 0) {
      queueMicrotask(() => {
        focusFirstInvalid(form);
      });
      return;
    }
    change.mutate();
  }

  const failure = change.error instanceof AuthError ? change.error.kind : 'unknown';

  return (
    <section aria-labelledby={headingId}>
      <Card>
        <CardHeader>
          <h2 id={headingId} className="text-lg font-semibold">
            {t('security.password.title')}
          </h2>
          <CardDescription>{t('security.password.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form noValidate onSubmit={onSubmit} className="grid gap-4">
            <FormField
              label={t('security.password.current')}
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              value={current}
              error={errors.current}
              onChange={(event) => {
                setCurrent(event.target.value);
              }}
            />
            <FormField
              label={t('resetPassword.newPassword')}
              name="newPassword"
              type="password"
              autoComplete="new-password"
              hint={t('auth.passwordHint', { count: PASSWORD_MIN_LENGTH })}
              value={next}
              error={errors.next}
              onChange={(event) => {
                setNext(event.target.value);
              }}
            />
            {change.isError && (
              <p role="alert" className="text-sm font-medium text-destructive">
                {t(`auth.errors.${failure}`, { count: PASSWORD_MIN_LENGTH })}
              </p>
            )}
            {change.isSuccess && (
              <p role="status" className="text-sm">
                {t('security.password.done')}
              </p>
            )}
            <Button type="submit" className="w-fit" disabled={change.isPending}>
              {t('security.password.submit')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </section>
  );
}

/** Account security: applies to the person, in every organization. */
export function SecurityPage() {
  const { t } = useTranslation();
  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold">{t('security.title')}</h1>
      <div className="grid gap-6">
        <TwoFactorSection />
        <ChangePasswordSection />
      </div>
    </>
  );
}
