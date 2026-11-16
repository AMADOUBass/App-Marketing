import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { FAKE_TOTP_CODE, installFakeApi } from './fake-api';

/** WCAG 2.2 A/AA automated checks (axe-core). Manual checks remain necessary. */
async function expectNoAccessibilityViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

const PASSWORD = 'correct-horse-battery-staple';

test.use({ locale: 'fr-CA' });

test('turn on two-factor authentication, then sign in with the app code', async ({ page }) => {
  await installFakeApi(page, [
    {
      name: 'Amélie',
      email: 'amelie@agence.ca',
      password: PASSWORD,
      organizations: [
        {
          organizationId: '0195f000-0000-7000-8000-00000000000a',
          name: 'Agence Tremblay',
          role: 'owner',
          posts: [],
        },
      ],
    },
  ]);
  await page.goto('/login');
  await page.getByLabel('Adresse courriel').fill('amelie@agence.ca');
  await page.getByLabel('Mot de passe').fill(PASSWORD);
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await expect(page).toHaveURL(/\/posts$/);

  await page.getByRole('link', { name: 'Sécurité' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Sécurité du compte' })).toBeVisible();
  // The passkeys section is there too (Chromium supports WebAuthn), checked by axe below.
  await expect(page.getByText('Aucune passkey pour l’instant.')).toBeVisible();
  await expectNoAccessibilityViolations(page);

  await page.getByRole('button', { name: 'Activer la double authentification' }).click();
  await page.getByLabel('Confirmez votre mot de passe').fill(PASSWORD);
  await page.getByRole('button', { name: 'Activer la double authentification' }).click();
  await expect(page.getByRole('img', { name: /Code QR/ })).toBeVisible();
  await expect(page.getByText('JBSW Y3DP EHPK 3PXP')).toBeVisible();
  await expectNoAccessibilityViolations(page);

  await page.getByLabel('Code de vérification').fill(FAKE_TOTP_CODE);
  await page.getByRole('button', { name: 'Confirmer et activer' }).click();
  await expect(
    page.getByRole('list', { name: 'Codes de secours' }).getByRole('listitem'),
  ).toHaveCount(10);
  await expectNoAccessibilityViolations(page);
  await page.getByRole('button', { name: 'J’ai enregistré mes codes' }).click();
  await expect(page.getByText('activée', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Se déconnecter' }).click();
  await expect(page).toHaveURL(/\/login$/);

  // Sign in again: the password alone is not enough any more.
  await page.getByLabel('Adresse courriel').fill('amelie@agence.ca');
  await page.getByLabel('Mot de passe').fill(PASSWORD);
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Vérification en deux étapes' })).toBeFocused();
  await expectNoAccessibilityViolations(page);

  await page.getByLabel('Code de vérification').fill('000000');
  await page.getByRole('button', { name: 'Vérifier' }).click();
  await expect(page.getByRole('alert')).toContainText('Code incorrect.');

  await page.getByLabel('Code de vérification').fill(FAKE_TOTP_CODE);
  await page.getByRole('button', { name: 'Vérifier' }).click();
  await expect(page).toHaveURL(/\/posts$/);
});
