import { Button, Card, CardContent, CardDescription, CardHeader } from '@ponctua/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthError, authApi } from '../lib/auth';
import { forgetSession } from '../lib/me';
import { passkeys } from '../lib/passkeys';
import { FormField } from './form-field';

const passkeysQuery = { queryKey: ['passkeys'], queryFn: passkeys.list } as const;

/** Passkeys of the signed-in person: sign in with the device (Touch ID, Windows Hello, phone). */
export function PasskeysSection() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const headingId = useId();
  const [name, setName] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const supported = passkeys.supported();
  const list = useQuery({ ...passkeysQuery, enabled: supported });

  const refresh = () => queryClient.invalidateQueries({ queryKey: passkeysQuery.queryKey });
  const add = useMutation({
    mutationFn: () => passkeys.add(name),
    onSuccess: async () => {
      setName('');
      setNotice(t('passkeys.added'));
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: passkeys.remove,
    onSuccess: async () => {
      setNotice(t('passkeys.removed'));
      await refresh();
    },
  });
  // Adding needs a recent sign-in (ADR 011): sign out, then sign in again.
  const signInAgain = useMutation({
    mutationFn: authApi.signOut,
    onSuccess: async () => {
      forgetSession(queryClient);
      await navigate({ to: '/login' });
    },
  });

  const addFailure = add.error instanceof AuthError ? add.error.kind : 'unknown';
  const dateFormat = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' });
  const items = list.data ?? [];

  return (
    <section aria-labelledby={headingId}>
      <Card>
        <CardHeader>
          <h2 id={headingId} className="text-lg font-semibold">
            {t('passkeys.title')}
          </h2>
          <CardDescription>{t('passkeys.description')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {!supported ? (
            <p className="text-sm">{t('passkeys.unsupported')}</p>
          ) : (
            <>
              {notice && (
                <p role="status" className="text-sm">
                  {notice}
                </p>
              )}
              <div aria-live="polite" aria-busy={list.isPending}>
                {list.isPending && <p className="text-sm">{t('passkeys.loading')}</p>}
                {list.isError && <p className="text-sm">{t('passkeys.error')}</p>}
                {list.isSuccess && items.length === 0 && (
                  <p className="text-sm">{t('passkeys.empty')}</p>
                )}
              </div>
              {items.length > 0 && (
                <ul className="grid gap-2">
                  {items.map((item) => {
                    const label = item.name ?? t('passkeys.unnamed');
                    return (
                      <li
                        key={item.id}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2"
                      >
                        <span className="text-sm">
                          <span className="font-medium">{label}</span>
                          <span className="block text-muted-foreground">
                            {item.deviceType === 'multiDevice'
                              ? t('passkeys.synced')
                              : t('passkeys.thisDevice')}
                            {item.createdAt
                              ? ` · ${t('passkeys.addedOn', { date: dateFormat.format(item.createdAt) })}`
                              : ''}
                          </span>
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={remove.isPending}
                          aria-label={t('passkeys.removeNamed', { name: label })}
                          onClick={() => {
                            setNotice(null);
                            remove.mutate(item.id);
                          }}
                        >
                          {t('passkeys.remove')}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
              <form
                noValidate
                className="grid gap-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  setNotice(null);
                  add.mutate();
                }}
              >
                <FormField
                  label={t('passkeys.nameLabel')}
                  hint={t('passkeys.nameHint')}
                  name="passkeyName"
                  autoComplete="off"
                  maxLength={60}
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                  }}
                />
                {add.isError && addFailure !== 'passkeyCancelled' && (
                  <div role="alert" className="grid justify-items-start gap-2">
                    <p className="text-sm font-medium text-destructive">
                      {t(`auth.errors.${addFailure}`)}
                    </p>
                    {addFailure === 'sessionNotFresh' && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          signInAgain.mutate();
                        }}
                      >
                        {t('passkeys.signInAgain')}
                      </Button>
                    )}
                  </div>
                )}
                <Button type="submit" className="w-fit" disabled={add.isPending}>
                  {add.isPending ? t('passkeys.adding') : t('passkeys.add')}
                </Button>
              </form>
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
