import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import fr from './locales/fr.json';

export const LANGUAGES = ['fr', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];

const STORAGE_KEY = 'app-language';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof fr };
  }
}

function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

/** Saved choice first, then the browser language; French by default (Canada, FR first). */
function initialLanguage(): Language {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLanguage(saved)) return saved;
  } catch {
    // Storage can be unavailable (private mode, blocked site data): fall back to the browser.
  }
  return navigator.language.toLowerCase().startsWith('en') ? 'en' : 'fr';
}

export function setLanguage(language: Language): void {
  void i18n.changeLanguage(language);
  try {
    localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // Not persisted: the choice still applies to this visit.
  }
}

/** Keeps <html lang> in sync so screen readers pronounce the content correctly (WCAG 3.1.1). */
function syncDocumentLanguage(language: string): void {
  document.documentElement.lang = language;
}

void i18n.use(initReactI18next).init({
  resources: { fr: { translation: fr }, en: { translation: en } },
  lng: initialLanguage(),
  fallbackLng: 'fr',
  supportedLngs: [...LANGUAGES],
  interpolation: { escapeValue: false }, // React already escapes.
  initAsync: false,
});
syncDocumentLanguage(i18n.language);
i18n.on('languageChanged', syncDocumentLanguage);

export { i18n };
