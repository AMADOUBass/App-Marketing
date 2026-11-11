import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

const ORG_ID = '0195f000-0000-7000-8000-00000000000a';

/** WCAG 2.2 A/AA automated checks (axe-core). Manual checks remain necessary. */
async function expectNoAccessibilityViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

// A French-Canadian browser: the app follows the browser language by default.
test.use({ locale: 'fr-CA' });

test.beforeEach(async ({ page }) => {
  // Mocked API: the dev header must carry the chosen organization.
  await page.route('**/api/v1/posts**', async (route) => {
    const organizationId = route.request().headers()['x-dev-organization-id'];
    if (organizationId !== ORG_ID) {
      await route.fulfill({
        status: 401,
        contentType: 'application/problem+json',
        body: JSON.stringify({ type: 'about:blank', title: 'Unauthorized', status: 401 }),
      });
      return;
    }
    const date = '2026-11-10T14:30:00.000Z';
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            id: '0195f000-0000-7000-8000-000000000101',
            workspaceId: '0195f000-0000-7000-8000-000000000201',
            body: 'Lancement de la collection automne',
            createdAt: date,
            updatedAt: date,
          },
        ],
        nextCursor: null,
      }),
    });
  });
});

test('sign in with an organization, then see its posts (French)', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Connexion' })).toBeVisible();
  await expectNoAccessibilityViolations(page);

  await page.getByLabel("Identifiant de l'organisation").fill('pas-un-uuid');
  await page.getByRole('button', { name: 'Continuer' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Saisissez un identifiant valide (format UUID).',
  );
  await expectNoAccessibilityViolations(page);

  await page.getByLabel("Identifiant de l'organisation").fill(ORG_ID);
  await page.getByRole('button', { name: 'Continuer' }).click();

  await expect(page).toHaveURL(/\/posts$/);
  await expect(page.getByText('Lancement de la collection automne')).toBeVisible();
  await expectNoAccessibilityViolations(page);
});

test('the whole flow works with the keyboard only, in English', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  // The choice is remembered across reloads.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();

  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();

  await page.getByLabel('Organization ID').focus();
  await page.keyboard.type(ORG_ID);
  await page.keyboard.press('Enter');

  await expect(page.getByRole('heading', { level: 1, name: 'Posts' })).toBeVisible();
  await expect(page.getByText('Lancement de la collection automne')).toBeVisible();
});
