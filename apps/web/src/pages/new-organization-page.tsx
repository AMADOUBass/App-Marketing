import { createOrganizationSchema, userOrganizationSchema } from '@ponctua/contracts';
import { Button, Card, CardContent, CardDescription, CardHeader } from '@ponctua/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { type SubmitEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField, focusFirstInvalid } from '../components/form-field';
import { apiRequest } from '../lib/api';
import { enterOrganization, meQuery } from '../lib/me';

/** Onboarding: the creator becomes owner of the new organization (and of its first workspace). */
export function NewOrganizationPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const hasOrganizations = (useQuery(meQuery).data?.organizations.length ?? 0) > 0;
  const [name, setName] = useState('');
  const [invalid, setInvalid] = useState(false);

  const create = useMutation({
    mutationFn: (input: { name: string }) =>
      apiRequest('/organizations', userOrganizationSchema, { method: 'POST', body: input }),
    onSuccess: async (organization) => {
      enterOrganization(queryClient, organization.organizationId);
      await queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
      await navigate({ to: '/posts' });
    },
  });

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const parsed = createOrganizationSchema.safeParse({ name });
    if (!parsed.success) {
      setInvalid(true);
      queueMicrotask(() => {
        focusFirstInvalid(form);
      });
      return;
    }
    setInvalid(false);
    create.mutate(parsed.data);
  }

  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold">{t('organizations.new.title')}</h1>
      <Card>
        <CardHeader>
          <CardDescription>{t('organizations.new.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form noValidate onSubmit={onSubmit} className="grid gap-4">
            <FormField
              label={t('organizations.new.nameLabel')}
              name="organizationName"
              autoComplete="organization"
              hint={t('organizations.new.nameHint')}
              error={invalid ? t('organizations.new.nameInvalid') : undefined}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
            {create.isError && (
              <p role="alert" className="text-sm font-medium text-destructive">
                {t('organizations.new.error')}
              </p>
            )}
            <Button type="submit" className="w-fit" disabled={create.isPending}>
              {create.isPending ? t('organizations.new.submitting') : t('organizations.new.submit')}
            </Button>
          </form>
          {hasOrganizations && (
            <p className="mt-6 text-sm">
              <Link to="/organizations" className="font-medium underline underline-offset-4">
                {t('organizations.new.back')}
              </Link>
            </p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
