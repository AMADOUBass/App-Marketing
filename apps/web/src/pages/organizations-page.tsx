import { Button, Card, CardContent } from '@ponctua/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { enterOrganization, meQuery } from '../lib/me';

/** Shown when the user belongs to several organizations and none is chosen yet. */
export function OrganizationsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const organizations = useQuery(meQuery).data?.organizations ?? [];

  return (
    <>
      <h1 className="mb-2 text-2xl font-semibold">{t('organizations.title')}</h1>
      <p className="mb-6 text-sm text-muted-foreground">{t('organizations.description')}</p>
      <ul className="mb-6 grid gap-3">
        {organizations.map((organization) => (
          <li key={organization.organizationId}>
            <Card className="py-4">
              <CardContent className="flex items-center justify-between gap-4">
                <span>
                  <span className="font-medium">{organization.name}</span>{' '}
                  <span className="text-sm text-muted-foreground">
                    ({t(`organizations.roles.${organization.role}`)})
                  </span>
                </span>
                <Button
                  size="sm"
                  // The visible text alone ("Open") would be ambiguous in a list (WCAG 2.4.6).
                  aria-label={t('organizations.openNamed', { name: organization.name })}
                  onClick={() => {
                    enterOrganization(queryClient, organization.organizationId);
                    void navigate({ to: '/posts' });
                  }}
                >
                  {t('organizations.open')}
                </Button>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
      <Link to="/organizations/new" className="text-sm font-medium underline underline-offset-4">
        {t('organizations.create')}
      </Link>
    </>
  );
}
