import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { installFakeApi } from './fake-api';

/** WCAG 2.2 A/AA automated checks (axe-core). Manual checks remain necessary. */
async function expectNoAccessibilityViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

const PASSWORD = 'correct-horse-battery-staple';

test.use({ locale: 'fr-CA' });

test('each post shows where it goes and how far it got; a scheduled one can be cancelled', async ({
  page,
}) => {
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
          posts: [
            { body: 'Croissants du samedi', targetStates: ['scheduled'] },
            { body: 'Horaires des fêtes', targetStates: ['published'] },
            { body: 'Concours', targetStates: ['needs_action'] },
          ],
        },
      ],
    },
  ]);
  await page.goto('/login');
  await page.getByLabel('Adresse courriel').fill('amelie@agence.ca');
  await page.getByLabel('Mot de passe').fill(PASSWORD);
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();

  await expect(page.getByText('Programmé')).toBeVisible();
  await expect(page.getByText('Publié', { exact: true })).toBeVisible();
  await expect(page.getByText('Action requise')).toBeVisible();
  await expect(page.getByText('Instagram · demo')).toHaveCount(3);
  await expectNoAccessibilityViolations(page);

  await page
    .getByRole('listitem')
    .filter({ hasText: 'Programmé' })
    .getByRole('button', { name: 'Annuler la publication sur Instagram · demo' })
    .click();
  await expect(page.getByText('Annulé')).toBeVisible();
  await expect(page.getByText('Programmé')).toHaveCount(0);
});
