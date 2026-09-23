import { expect, test } from '@playwright/test';

test('the app loads in mock mode', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('./');
  await expect(page).toHaveTitle('Vehicles');
  await expect(page.locator('#app')).not.toBeEmpty();
  expect(errors).toEqual([]);
});
