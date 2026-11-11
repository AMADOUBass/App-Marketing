import { Outlet } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { LanguageSwitcher } from './language-switcher';

export function AppShell() {
  const { t } = useTranslation();

  useEffect(() => {
    document.title = t('app.name');
  }, [t]);

  return (
    <div className="min-h-screen">
      {/* First focusable element: lets keyboard users jump over the header (WCAG 2.4.1). */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:shadow-md focus:ring-[3px] focus:ring-ring"
      >
        {t('app.skipToContent')}
      </a>
      <header className="border-b">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-4 py-3">
          <span className="font-semibold">{t('app.name')}</span>
          <LanguageSwitcher />
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto max-w-3xl px-4 py-8 outline-none">
        <Outlet />
      </main>
    </div>
  );
}
