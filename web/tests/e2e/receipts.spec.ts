/**
 * Add Receipt against the mock API. Headless Chromium has no camera, so the
 * scanner falls back to the "Take a photo" file input, which is fed a small
 * synthetic receipt photo (tests/e2e/fixtures/receipt.jpg; no real data).
 * Edge detection, the corner editor, clean-up and PDF building all run for
 * real on that still.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Bootstrap } from '../../src/api/types';
import { ownerUser, signInAs } from './helpers';

const appConfig = JSON.parse(readFileSync(new URL('../../app.config.json', import.meta.url), 'utf8')) as {
  googleDriveAppStoreUrl: string;
};

const owner = ownerUser();
const ownerData = JSON.parse(readFileSync(new URL(`../../src/mock/${owner.file}`, import.meta.url), 'utf8')) as Bootstrap;
const ownerDefault = ownerData.user.defaultVehicle!;

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const flow = (page: Page) => page.getByRole('dialog', { name: 'Add Receipt' });

async function openAddReceipt(page: Page): Promise<Locator> {
  await signInAs(page, owner.name);
  await expect(page.locator('.topbar-title')).toHaveText(ownerDefault);
  await page.getByRole('button', { name: /Add Receipt/ }).click();
  const f = flow(page);
  await expect(f.getByRole('button', { name: /Scan a paper receipt/ })).toBeVisible();
  return f;
}

/** Choose → coaching → fallback photo → adjust → pages tray, with one page. */
async function scanOnePage(page: Page): Promise<Locator> {
  const f = await openAddReceipt(page);
  await f.getByRole('button', { name: /Scan a paper receipt/ }).click();
  await expect(f.getByRole('heading', { name: 'One visit, one scan' })).toBeVisible();
  await expect(f.getByText('Lay it flat on something dark.')).toBeVisible();
  await f.getByRole('button', { name: 'Start scanning' }).click();

  // No camera here, so the iPhone-camera fallback appears.
  const input = f.getByLabel('Take a photo');
  await expect(input).toBeAttached({ timeout: 15_000 });
  await input.setInputFiles(fixture('receipt.jpg'));

  // Adjust: four corner handles, placed by edge detection (OpenCV loads first).
  for (const corner of ['Top left corner', 'Top right corner', 'Bottom right corner', 'Bottom left corner']) {
    await expect(f.getByRole('button', { name: corner })).toBeVisible({ timeout: 45_000 });
  }
  await expect(f.getByRole('radio', { name: 'Document' })).toHaveAttribute('aria-checked', 'true');
  // Nudge a corner with the keyboard.
  await f.getByRole('button', { name: 'Top left corner' }).press('ArrowRight');
  await f.getByRole('button', { name: 'Use this page' }).click();

  await expect(f.getByRole('img', { name: 'Page 1' })).toBeVisible({ timeout: 20_000 });
  return f;
}

test.describe('Add Receipt', () => {
  test.setTimeout(120_000);

  test('scan a paper receipt and find it in My scans', async ({ page }) => {
    const f = await scanOnePage(page);

    // Closing with pages asks first.
    await f.getByRole('button', { name: 'Cancel' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Discard this?' });
    await expect(confirm).toContainText('1 page');
    await confirm.getByRole('button', { name: 'Keep going' }).click();
    await expect(f.getByRole('img', { name: 'Page 1' })).toBeVisible();

    await f.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(f.getByRole('heading', { name: 'Which car?' })).toBeVisible();
    await expect(f.getByRole('radio', { name: ownerDefault })).toHaveAttribute('aria-checked', 'true');
    await expect(f.getByText('only a hint')).toBeVisible();
    await f.getByRole('button', { name: 'Upload' }).click();

    await expect(f.getByRole('heading', { name: 'Got it!' })).toBeVisible({ timeout: 20_000 });
    await expect(f.getByText('Your receipt is in the pile. It’s usually filed within a few hours.')).toBeVisible();
    await f.getByRole('button', { name: 'See my scans' }).click();

    await expect(page).toHaveURL(/#\/scans$/);
    const scans = page.getByRole('dialog', { name: 'My scans' });
    const row = scans.getByRole('link', { name: /Receipt scan/ }).filter({ hasText: 'Waiting to be filed' });
    await expect(row).toHaveCount(1);
    await row.click();
    await expect(page.getByRole('dialog', { name: 'Receipt scan' }).getByText('Car you picked')).toBeVisible();
  });

  test('offline: the scan waits on the phone, then uploads when back online', async ({ page, context }) => {
    const f = await scanOnePage(page);
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await f.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(f.getByRole('radio', { name: ownerDefault })).toHaveAttribute('aria-checked', 'true');

    await context.setOffline(true);
    await f.getByRole('button', { name: 'Upload' }).click();
    await expect(f.getByRole('heading', { name: 'Got it!' })).toBeVisible({ timeout: 20_000 });
    await expect(f.getByText('will upload by itself when you’re back online')).toBeVisible();
    await f.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(flow(page)).toHaveCount(0);

    const chip = page.getByRole('button', { name: '1 scan waiting to upload' });
    await expect(chip).toBeVisible();
    // Still there after the app restarts offline: the PDF is in IndexedDB.
    await page.reload();
    await expect(page.locator('.topbar-title')).toHaveText(ownerDefault);
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(page.getByRole('dialog', { name: 'My scans' }).getByText('Waiting to upload')).toBeVisible();
    await page.getByRole('dialog', { name: 'My scans' }).getByRole('button', { name: 'Done' }).click();

    await context.setOffline(false);
    await expect(chip).toHaveCount(0, { timeout: 20_000 });
    await page.evaluate(() => { location.hash = '#/scans'; });
    const scans = page.getByRole('dialog', { name: 'My scans' });
    await expect(scans.getByRole('link', { name: /Receipt scan/ }).filter({ hasText: 'Waiting to be filed' })).toHaveCount(1);
    await expect(scans.getByText('On this phone')).toHaveCount(0);
  });

  test('upload a digital receipt (PDF)', async ({ page }) => {
    const f = await openAddReceipt(page);
    await f.getByRole('button', { name: /Upload a digital receipt/ }).click();
    await expect(f.getByText('Got the receipt by email? Save the attachment to your iPhone')).toBeVisible();
    await expect(f.getByRole('img', { name: /Mail, then tap the PDF/ })).toBeVisible();
    await f.getByRole('button', { name: 'Got it' }).click();
    await expect(f.getByRole('img', { name: /Mail, then tap the PDF/ })).toHaveCount(0);

    await f.getByLabel('Choose files').setInputFiles(fixture('invoice.pdf'));
    await expect(f.getByText('PDF · 2 pages')).toBeVisible({ timeout: 20_000 });
    await f.getByRole('button', { name: 'Next' }).click();
    await expect(f.getByRole('radio', { name: ownerDefault })).toHaveAttribute('aria-checked', 'true');
    // One tap to change the car.
    const other = ownerData.vehicles.find(v => v.name !== ownerDefault)!.name;
    await f.getByRole('radio', { name: other }).click();
    await expect(f.getByRole('radio', { name: other })).toHaveAttribute('aria-checked', 'true');
    await f.getByRole('button', { name: 'Upload' }).click();
    await expect(f.getByRole('heading', { name: 'Got it!' })).toBeVisible({ timeout: 20_000 });
    await f.getByRole('button', { name: 'See my scans' }).click();

    const scans = page.getByRole('dialog', { name: 'My scans' });
    await expect(scans.getByRole('link', { name: /Digital receipt/ }).filter({ hasText: 'Waiting to be filed' })).toHaveCount(1);
  });

  test('work I did myself makes an Owner entry scan', async ({ page }) => {
    const f = await openAddReceipt(page);
    await f.getByRole('button', { name: /Work I did myself/ }).click();
    await expect(f.getByLabel('Vehicle')).toHaveValue(ownerDefault);

    // Nothing picked yet: a friendly error.
    await f.getByRole('button', { name: 'Upload' }).click();
    await expect(f.getByRole('alert')).toContainText('Pick what you did');

    await f.getByRole('checkbox', { name: ownerData.serviceTypes[0] }).check();
    await f.getByLabel('Mileage (optional)').fill('41,000');
    await f.getByRole('checkbox', { name: /Approximately \(the mileage\)/ }).check();
    await f.getByLabel('Parts cost (optional)').fill('24.99');
    await f.getByRole('button', { name: 'Upload' }).click();

    await expect(f.getByRole('heading', { name: 'Got it!' })).toBeVisible({ timeout: 20_000 });
    await f.getByRole('button', { name: 'See my scans' }).click();
    const scans = page.getByRole('dialog', { name: 'My scans' });
    await expect(scans.getByRole('link', { name: /Owner entry/ }).filter({ hasText: 'Waiting to be filed' })).toHaveCount(1);
  });

  test('the Google Drive scanner card', async ({ page }) => {
    const f = await openAddReceipt(page);
    await f.getByRole('button', { name: 'Use the Google Drive scanner instead' }).click();
    await expect(f.getByText('Tap + then Scan.')).toBeVisible();
    await expect(f.getByText('Scan every page from this one visit.')).toBeVisible();
    await expect(f.getByText('Tap Save and choose Family Share › Vehicles › Inbox.')).toBeVisible();
    await expect(f.getByText(/Come back here by tapping the .+ icon on your home screen\./)).toBeVisible();
    await expect(f.getByText('These won’t show a status here, but they’ll still be filed.')).toBeVisible();
    await expect(f.getByRole('button', { name: 'Open Google Drive' })).toBeVisible();
    await expect(f.getByRole('link', { name: 'Don’t have the Drive app?' })).toHaveAttribute('href', appConfig.googleDriveAppStoreUrl);
    // Nothing redirected on its own.
    await expect(page).toHaveURL(/#\/v\//);

    await f.getByRole('button', { name: 'Back' }).click();
    await f.getByRole('button', { name: 'Cancel' }).click();
    await expect(flow(page)).toHaveCount(0);
  });
});
