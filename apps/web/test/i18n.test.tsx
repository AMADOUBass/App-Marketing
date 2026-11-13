import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import en from '../src/i18n/locales/en.json';
import fr from '../src/i18n/locales/fr.json';
import { mockApi, renderApp, SIGNED_OUT } from './helpers';

function keys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    keys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe('translations', () => {
  it('French and English have exactly the same keys (no missing translation)', () => {
    expect(keys(en).sort()).toEqual(keys(fr).sort());
  });

  it('no translation is empty', () => {
    const values = (obj: unknown): unknown[] =>
      typeof obj === 'object' && obj !== null ? Object.values(obj).flatMap(values) : [obj];
    for (const value of [...values(fr), ...values(en)]) {
      expect(typeof value === 'string' && value.trim().length > 0).toBe(true);
    }
  });

  it('switches the interface and <html lang> to English', async () => {
    mockApi({ '/api/v1/me': SIGNED_OUT });
    renderApp('/login');
    expect(await screen.findByRole('heading', { level: 1, name: 'Connexion' })).toBeTruthy();
    expect(document.documentElement.lang).toBe('fr');

    await userEvent.click(screen.getByRole('button', { name: 'English' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeTruthy();
    expect(document.documentElement.lang).toBe('en');
    expect(screen.getByRole('button', { name: 'English' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('offers a skip link to the main content as the first focusable element', async () => {
    mockApi({ '/api/v1/me': SIGNED_OUT });
    renderApp('/login');
    await screen.findByRole('heading', { level: 1 });

    await userEvent.tab();

    const skip = screen.getByRole('link', { name: 'Aller au contenu principal' });
    expect(document.activeElement).toBe(skip);
    expect(skip.getAttribute('href')).toBe('#main');
  });
});
