import { Button } from '@ponctua/ui';
import { useRouter } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

/** A page could not load (API unreachable, unexpected answer). Never shows technical details. */
export function RouteError() {
  const { t } = useTranslation();
  const router = useRouter();
  return (
    <div role="alert" className="grid justify-items-start gap-3">
      <p>{t('errors.page')}</p>
      <Button variant="outline" onClick={() => void router.invalidate()}>
        {t('errors.retry')}
      </Button>
    </div>
  );
}
