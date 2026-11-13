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

test.describe('French-Canadian browser', () => {
  // The app follows the browser language by default.
  test.use({ locale: 'fr-CA' });

  test('sign up, confirm the address, create the organization, see its posts, sign out', async ({
    page,
  }) => {
    const api = await installFakeApi(page);
    await page.goto('/');

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Connexion' })).toBeVisible();
    await expectNoAccessibilityViolations(page);

    await page.getByRole('link', { name: 'Créer un compte' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Créer un compte' })).toBeVisible();

    // Too short a password: refused before any request, with the error tied to the field.
    await page.getByLabel('Nom').fill('Amélie Tremblay');
    await page.getByLabel('Adresse courriel').fill('amelie@agence.ca');
    await page.getByLabel('Mot de passe').fill('trop-court');
    await page.getByRole('button', { name: 'Créer mon compte' }).click();
    await expect(page.getByLabel('Mot de passe')).toBeFocused();
    await expect(page.getByLabel('Mot de passe')).toHaveAttribute('aria-invalid', 'true');
    await expectNoAccessibilityViolations(page);

    await page.getByLabel('Mot de passe').fill(PASSWORD);
    await page.getByRole('button', { name: 'Créer mon compte' }).click();

    // No session yet: the emailed link opens it.
    await expect(page.getByRole('heading', { name: 'Vérifiez vos courriels' })).toBeFocused();
    await expectNoAccessibilityViolations(page);
    api.confirmEmail('amelie@agence.ca');
    await page.goto('/email-verified');
    await expect(page.getByRole('heading', { name: 'Adresse confirmée' })).toBeVisible();
    await expectNoAccessibilityViolations(page);
    await page.getByRole('link', { name: 'Continuer' }).click();

    await expect(
      page.getByRole('heading', { level: 1, name: 'Créer votre organisation' }),
    ).toBeVisible();
    await expectNoAccessibilityViolations(page);
    await page.getByLabel("Nom de l'organisation").fill('Agence Tremblay');
    await page.getByRole('button', { name: "Créer l'organisation" }).click();

    await expect(page).toHaveURL(/\/posts$/);
    await expect(page.getByText("Aucune publication pour l'instant.")).toBeVisible();
    await expect(page.getByText('Agence Tremblay')).toBeVisible();
    await expectNoAccessibilityViolations(page);

    await page.getByRole('button', { name: 'Se déconnecter' }).click();
    await expect(page).toHaveURL(/\/login$/);

    // Signed out for real: the app pages send back to sign-in.
    await page.goto('/posts');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('forgotten password: ask for a link, set a new password, sign in with it', async ({
    page,
  }) => {
    const api = await installFakeApi(page, [
      { name: 'Amélie', email: 'amelie@agence.ca', password: PASSWORD, organizations: [] },
    ]);
    await page.goto('/login');
    await page.getByRole('link', { name: 'Mot de passe oublié ?' }).click();

    await page.getByLabel('Adresse courriel').fill('amelie@agence.ca');
    await page.getByRole('button', { name: 'Envoyer le lien' }).click();
    await expect(page.getByRole('heading', { name: 'Vérifiez vos courriels' })).toBeFocused();
    await expectNoAccessibilityViolations(page);

    // Opening the emailed link: the token leaves the address bar at once.
    await page.goto(`/reset-password?token=${api.resetTokens()[0] ?? ''}`);
    await expect(page).toHaveURL(/\/reset-password$/);
    await expectNoAccessibilityViolations(page);
    await page.getByLabel('Nouveau mot de passe').fill('a-brand-new-passphrase');
    await page.getByRole('button', { name: 'Enregistrer le mot de passe' }).click();
    await expect(page.getByRole('heading', { name: 'Mot de passe modifié' })).toBeFocused();

    await page.getByRole('link', { name: 'Se connecter' }).click();
    await page.getByLabel('Adresse courriel').fill('amelie@agence.ca');
    await page.getByLabel('Mot de passe').fill('a-brand-new-passphrase');
    await page.getByRole('button', { name: 'Se connecter' }).click();
    await expect(page).toHaveURL(/\/organizations\/new$/);
  });

  test('a wrong password gets one message, whatever was wrong', async ({ page }) => {
    await installFakeApi(page, [
      { name: 'Amélie', email: 'amelie@agence.ca', password: PASSWORD, organizations: [] },
    ]);
    await page.goto('/login');

    await page.getByLabel('Adresse courriel').fill('amelie@agence.ca');
    await page.getByLabel('Mot de passe').fill('pas-le-bon-mot-de-passe');
    await page.getByRole('button', { name: 'Se connecter' }).click();

    await expect(page.getByRole('alert')).toHaveText('Adresse courriel ou mot de passe incorrect.');
    await expectNoAccessibilityViolations(page);
  });
});

test('keyboard only, in English: sign in, choose and switch organizations', async ({ page }) => {
  const api = await installFakeApi(page, [
    {
      name: 'Amélie',
      email: 'amelie@agency.ca',
      password: PASSWORD,
      organizations: [
        {
          organizationId: '0195f000-0000-7000-8000-00000000000a',
          name: 'Agency A',
          role: 'owner',
          posts: ['Fall collection launch'],
        },
        {
          organizationId: '0195f000-0000-7000-8000-00000000000b',
          name: 'Agency B',
          role: 'member',
          posts: ['Winter menu is here'],
        },
      ],
    },
  ]);
  await page.goto('/login');
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  // The choice is remembered across reloads.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();

  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();

  await page.getByLabel('Email address').focus();
  await page.keyboard.type('amelie@agency.ca');
  await page.keyboard.press('Tab');
  await page.keyboard.type(PASSWORD);
  await page.keyboard.press('Enter');

  await expect(
    page.getByRole('heading', { level: 1, name: 'Choose an organization' }),
  ).toBeVisible();
  await expectNoAccessibilityViolations(page);
  await page.getByRole('button', { name: 'Open Agency A' }).focus();
  await page.keyboard.press('Enter');

  await expect(page.getByRole('heading', { level: 1, name: 'Posts' })).toBeVisible();
  await expect(page.getByText('Fall collection launch')).toBeVisible();
  await expectNoAccessibilityViolations(page);

  // Switch organization: only B's data is shown, and only B is asked for from now on.
  const before = api.organizationHeaders.length;
  await page.getByLabel('Organization').selectOption({ label: 'Agency B' });
  await expect(page.getByText('Winter menu is here')).toBeVisible();
  await expect(page.getByText('Fall collection launch')).toHaveCount(0);
  expect(new Set(api.organizationHeaders.slice(before))).toEqual(
    new Set(['0195f000-0000-7000-8000-00000000000b']),
  );
});
