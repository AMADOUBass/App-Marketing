import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

const linkClass =
  'rounded-md px-2 py-1 text-sm font-medium underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring outline-none [&.active]:underline';

/** Shown on signed-in pages. The current page is announced with aria-current (set by Link). */
export function MainNav() {
  const { t } = useTranslation();
  return (
    <nav aria-label={t('nav.label')} className="flex gap-2">
      <Link to="/posts" className={linkClass}>
        {t('nav.posts')}
      </Link>
      <Link to="/accounts" className={linkClass}>
        {t('nav.accounts')}
      </Link>
    </nav>
  );
}
