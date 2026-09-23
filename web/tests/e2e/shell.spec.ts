/**
 * The app shell against the mock API: sign-in, the vehicle pager, search,
 * settings, deep links and offline start-up. Expected values are read from the
 * synthetic fixture (src/mock/*.json), never hard-coded.
 */

import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { Bootstrap } from '../../src/api/types';
import { mockUsers, ownerUser, signInAs, type MockUser } from './helpers';

const appConfig = JSON.parse(readFileSync(new URL('../../app.config.json', import.meta.url), 'utf8')) as { familyName: string; appName: string };
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

function bootstrapOf(u: MockUser): Bootstrap {
  return JSON.parse(readFileSync(new URL(`../../src/mock/${u.file}`, import.meta.url), 'utf8')) as Bootstrap;
}

const owner = ownerUser();
const ownerData = bootstrapOf(owner);
const vehicleNames = ownerData.vehicles.map(v => v.name);
const ownerDefault = ownerData.user.defaultVehicle!;

const title = (page: Page) => page.locator('.topbar-title');
const pager = (page: Page) => page.locator('.pager');

test.describe('sign-in', () => {
  test('mock sign-in lists the fixture people and opens on their own vehicle', async ({ page }) => {
    await page.goto('./');
    for (const u of mockUsers()) {
      await expect(page.getByRole('button', { name: `Continue as ${u.name}` })).toBeVisible();
    }
    const other = mockUsers().find(u => u.email !== owner.email)!;
    await page.getByRole('button', { name: `Continue as ${other.name}` }).click();
    await expect(title(page)).toHaveText(bootstrapOf(other).user.defaultVehicle!);
  });

  test('a stale session goes back to sign-in, and a stranger sees the family-only screen', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('vehicles.session', `mock.${btoa('stranger@example.com')}`);
    });
    await page.goto('./');
    await expect(page.getByText('Please sign in again.')).toBeVisible();
    await expect(page.getByRole('button', { name: `Continue as ${owner.name}` })).toBeVisible();

    await page.getByLabel('Another Google account (mock)').fill('stranger@example.com');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: `This app is for the ${appConfig.familyName} family` })).toBeVisible();

    await page.getByRole('button', { name: 'Use a different account' }).click();
    await expect(page.getByRole('button', { name: `Continue as ${owner.name}` })).toBeVisible();
  });

  test('sign in on another device with a one-time code', async ({ page }) => {
    await signInAs(page, owner.name);
    await expect(title(page)).toHaveText(ownerDefault);
    await page.getByRole('button', { name: 'Settings' }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: 'Sign in on another device' }).click();
    const code = (await settings.locator('.pair-code').innerText()).replace(/\s/g, '');
    expect(code).toMatch(/^[A-Z0-9]{8}$/);

    // Sign out on this "device" (the mock keeps the code in memory), then redeem it.
    await settings.getByRole('button', { name: 'Sign out' }).click();
    await page.getByRole('button', { name: 'Use a sign-in code' }).click();
    await page.getByLabel('Sign-in code').fill(`${code.slice(0, 4)} ${code.slice(4)}`);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(title(page)).toHaveText(ownerDefault);
  });
});

test.describe('vehicle pager', () => {
  test('the owner opens on their default vehicle', async ({ page }) => {
    await signInAs(page, owner.name);
    await expect(title(page)).toHaveText(ownerDefault);
    await expect(page.getByRole('button', { name: `Show ${ownerDefault}` })).toHaveAttribute('aria-current', 'true');
    await expect(page).toHaveURL(new RegExp(`#/v/${encodeURIComponent(ownerDefault)}$`));
    await expect(page.getByRole('button', { name: /Add Receipt/ })).toBeVisible();
  });

  test('every vehicle is reachable by swiping', async ({ page }) => {
    await signInAs(page, owner.name);
    await expect(title(page)).toHaveText(ownerDefault);
    for (let i = 0; i < vehicleNames.length; i++) {
      await pager(page).evaluate((el, n) => el.scrollTo({ left: n * el.clientWidth, behavior: 'instant' as ScrollBehavior }), i);
      await expect(title(page)).toHaveText(vehicleNames[i]);
      await expect(page.getByRole('button', { name: `Show ${vehicleNames[i]}` })).toHaveAttribute('aria-current', 'true');
      await expect(page).toHaveURL(new RegExp(`#/v/${encodeURIComponent(vehicleNames[i])}$`));
      // Only the page on screen is exposed to VoiceOver.
      await expect(page.getByRole('group', { name: `${vehicleNames[i]}, ${i + 1} of ${vehicleNames.length}` })).toBeVisible();
    }
  });

  test('every vehicle is reachable with the page dots', async ({ page }) => {
    await signInAs(page, owner.name);
    await expect(title(page)).toHaveText(ownerDefault);
    for (const name of [...vehicleNames].reverse()) {
      await page.getByRole('button', { name: `Show ${name}` }).click();
      await expect(title(page)).toHaveText(name);
      await expect(page.getByRole('button', { name: `Show ${name}` })).toHaveAttribute('aria-current', 'true');
      const i = vehicleNames.indexOf(name);
      await expect.poll(() => pager(page).evaluate(el => Math.round(el.scrollLeft / el.clientWidth))).toBe(i);
    }
  });

  test('a deep link opens that vehicle', async ({ page }) => {
    const target = vehicleNames.find(n => n !== ownerDefault)!;
    await signInAs(page, owner.name, `#/v/${encodeURIComponent(target)}`);
    await expect(title(page)).toHaveText(target);
    await expect(page.getByRole('button', { name: `Show ${target}` })).toHaveAttribute('aria-current', 'true');
    await expect.poll(() => pager(page).evaluate(el => Math.round(el.scrollLeft / el.clientWidth))).toBe(vehicleNames.indexOf(target));
  });

  test('the last item on a page clears the Add Receipt button', async ({ page }) => {
    await signInAs(page, owner.name);
    await expect(title(page)).toHaveText(ownerDefault);
    const page0 = page.locator('.pager-page:not([aria-hidden="true"])');
    await page0.evaluate(el => el.scrollTo({ top: el.scrollHeight }));
    const fab = await page.getByRole('button', { name: /Add Receipt/ }).boundingBox();
    const lastBottom = await page0.locator('.vcard').evaluate(el => el.getBoundingClientRect().bottom);
    expect(fab).not.toBeNull();
    expect(lastBottom).toBeLessThanOrEqual(fab!.y);
  });
});

test.describe('search', () => {
  // The acceptance example (spec 8.10): "brakes jeep" finds the Jeep's rear brake service.
  const jeep = ownerData.vehicles.find(v => v.make === 'Jeep')!;
  const brakeVisit = jeep.visits.find(v => v.services.some(s => s.serviceType === 'Brake Service'))!;

  test('"brakes jeep" finds the Jeep brake visit and opens it', async ({ page }) => {
    await signInAs(page, owner.name);
    await expect(title(page)).toHaveText(ownerDefault);
    await page.getByRole('button', { name: 'Search all vehicles' }).click();
    const sheet = page.getByRole('dialog', { name: 'Search' });
    const field = sheet.getByRole('searchbox', { name: 'Search all vehicles' });
    await expect(field).toBeFocused();
    await field.fill('brakes jeep');

    const group = sheet.getByRole('region', { name: jeep.name });
    await expect(group).toBeVisible();
    await expect(sheet.locator('.search-group')).toHaveCount(1);
    const row = group.getByRole('button').filter({ hasText: brakeVisit.summary! });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(brakeVisit.location!);
    await expect(row.locator('mark').first()).toBeVisible();

    await row.click();
    await expect(page).toHaveURL(new RegExp(`#/v/${encodeURIComponent(jeep.name)}/visit/${encodeURIComponent(brakeVisit.visitId)}$`));
    await expect(title(page)).toHaveText(jeep.name);

    // Back from the visit returns to the same search.
    await page.goBack();
    await expect(page).toHaveURL(/#\/search\?q=brakes%20jeep$/);
    await expect(page.getByRole('searchbox', { name: 'Search all vehicles' })).toHaveValue('brakes jeep');
  });

  test('no matches, and clearing the field', async ({ page }) => {
    await signInAs(page, owner.name, '#/search');
    const sheet = page.getByRole('dialog', { name: 'Search' });
    const field = sheet.getByRole('searchbox', { name: 'Search all vehicles' });
    await field.fill('zzzz qqqq');
    await expect(sheet.locator('.search-empty').getByText('No matches', { exact: true })).toBeVisible();
    await sheet.getByRole('button', { name: 'Clear search' }).click();
    await expect(field).toHaveValue('');
    await expect(field).toBeFocused();
    await expect(sheet.locator('.search-empty')).toHaveCount(0);
  });
});

test.describe('settings', () => {
  test('shows the person, the version, and the notification section', async ({ page }) => {
    await signInAs(page, owner.name);
    await expect(title(page)).toHaveText(ownerDefault);
    await page.getByRole('button', { name: 'Settings' }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await expect(settings.getByText(ownerData.user.name, { exact: true })).toBeVisible();
    await expect(settings.getByTestId('app-version')).toHaveText(pkg.version);
    await expect(settings.getByRole('heading', { name: 'Notifications' })).toBeVisible();
    // A browser tab (not the home-screen app) explains why notifications aren't available.
    await expect(settings.getByText('Add to Home Screen first')).toBeVisible();

    const switches = settings.getByRole('switch');
    await expect(switches).toHaveCount(9);
    // Prefs from the fixture: missing keys mean on; explicit false is off.
    const receiptFiled = settings.getByRole('switch', { name: /Receipt filed/ });
    const expectedOn = ownerData.user.prefs.scanFiled !== false;
    await (expectedOn ? expect(receiptFiled).toBeChecked() : expect(receiptFiled).not.toBeChecked());
    await receiptFiled.click();
    await (expectedOn ? expect(receiptFiled).not.toBeChecked() : expect(receiptFiled).toBeChecked());

    await settings.getByRole('button', { name: 'Send a test notification' }).click();
    await expect(page.getByRole('status').filter({ hasText: /Sent to 1 device/ })).toBeVisible();

    await settings.getByRole('button', { name: 'Done' }).click();
    await expect(settings).toHaveCount(0);
    await expect(page).not.toHaveURL(/settings/);
  });

  test('the install guide opens from Settings in a browser tab', async ({ page }) => {
    await signInAs(page, owner.name, '#/settings');
    await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'How to add to Home Screen' }).click();
    const guide = page.getByRole('dialog', { name: /Add .* to your Home Screen/ });
    await expect(guide).toBeVisible();
    await expect(guide.getByText('Add to Home Screen', { exact: true }).first()).toBeVisible();
    await guide.getByRole('button', { name: 'Done' }).click();
    await expect(guide).toHaveCount(0);
  });
});

test.describe('install guide', () => {
  test('shows once in Safari on an iPhone, then remembers', async ({ page }) => {
    // Playwright marks itself as automated; pretend it's a person so the guide appears.
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true });
    });
    await page.goto('./');
    const guide = page.getByRole('dialog', { name: /Add .* to your Home Screen/ });
    await expect(guide).toBeVisible();
    await guide.getByRole('button', { name: 'Continue in Safari' }).click();
    await expect(guide).toHaveCount(0);
    await expect(page.getByRole('button', { name: `Continue as ${owner.name}` })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: `Continue as ${owner.name}` })).toBeVisible();
    await expect(guide).toHaveCount(0);
  });
});

test.describe('offline', () => {
  test('opens from the service worker cache and shows when the data is from', async ({ page, context }) => {
    await signInAs(page, owner.name);
    await expect(title(page)).toHaveText(ownerDefault);
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });

    await context.setOffline(true);
    await page.reload();
    await expect(title(page)).toHaveText(ownerDefault);
    await expect(page.getByText(/^Offline: showing data from \d{1,2}:\d{2}\s?[AP]M$/)).toBeVisible();
    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

    // Search still works on the saved data.
    await page.getByRole('button', { name: 'Search all vehicles' }).click();
    await page.getByRole('searchbox', { name: 'Search all vehicles' }).fill('brakes jeep');
    await expect(page.getByRole('dialog', { name: 'Search' }).locator('.search-result')).toHaveCount(1);

    await context.setOffline(false);
  });
});
