import { Button } from '@ponctua/ui';
import { useTranslation } from 'react-i18next';
import { LANGUAGES, setLanguage } from '../i18n';

/** Each button names its language in that language, with lang set, so it is announced correctly. */
export function LanguageSwitcher() {
  const { t, i18n } = useTranslation();

  return (
    <nav aria-label={t('language.label')} className="flex gap-1">
      {LANGUAGES.map((language) => (
        <Button
          key={language}
          variant="ghost"
          size="sm"
          // Visible state too, not only for screen readers.
          className="aria-pressed:bg-accent aria-pressed:underline aria-pressed:underline-offset-4"
          lang={language}
          aria-pressed={i18n.language === language}
          onClick={() => {
            setLanguage(language);
          }}
        >
          {t(`language.${language}`)}
        </Button>
      ))}
    </nav>
  );
}
