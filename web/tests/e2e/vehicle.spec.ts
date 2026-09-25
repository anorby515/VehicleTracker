/**
 * The vehicle card and its sheets against the mock API (spec 6, 8.2–8.9,
 * 8.11–8.13). Every expected value is read from the synthetic fixture
 * (src/mock/*.json) and formatted here independently of the app's helpers.
 */

import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Bootstrap, UpcomingItem, Vehicle } from '../../src/api/types';
import { ownerUser, signInAs } from './helpers';

const appConfig = JSON.parse(readFileSync(new URL('../../app.config.json', import.meta.url), 'utf8')) as { nhtsaRecallsUrl: string };

const owner = ownerUser();
const data = JSON.parse(readFileSync(new URL(`../../src/mock/${owner.file}`, import.meta.url), 'utf8')) as Bootstrap;

function vehicle(pred: (v: Vehicle) => boolean, what: string): Vehicle {
  const v = data.vehicles.find(pred);
  if (!v) throw new Error(`The fixture has no ${what}`);
  return v;
}

const fourRunner = vehicle(v => v.make === 'Toyota' && v.model === '4Runner', '4Runner');
const highlander = vehicle(v => v.make === 'Toyota' && v.model === 'Highlander', 'Highlander');
const bmw = vehicle(v => v.make === 'BMW', 'BMW');
const jeep = vehicle(v => v.make === 'Jeep', 'Jeep');

// ---------------------------------------------------------------- formatting (independent of src/lib/format.ts)

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}
const fmtMiles = (n: number) => `${n.toLocaleString('en-US')} mi`;
const fmtMoney = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------- locators

/** The page for one vehicle in the pager (only the one on screen is exposed). */
function card(page: Page, v: Vehicle): Locator {
  return page.getByRole('group', { name: new RegExp(`^${esc(v.name)}, \\d+ of \\d+$`) });
}

async function openVehicle(page: Page, v: Vehicle, sub = ''): Promise<Locator> {
  await signInAs(page, owner.name, `#/v/${encodeURIComponent(v.name)}${sub}`);
  await expect(page.locator('.topbar-title')).toHaveText(v.name);
  return card(page, v);
}

/** An Upcoming row by its exact title (titles like "Cabin Air Filter" and "Cabin air filter" differ only in case). */
function upcomingRow(region: Locator, title: string): Locator {
  return region.locator('.up-row').filter({ has: region.page().locator('.up-title', { hasText: new RegExp(`^${esc(title)}$`) }) });
}

function dueLine(item: UpcomingItem): string | null {
  const parts: string[] = [];
  if (item.dueBy) parts.push(`Due by ${fmtDate(item.dueBy)}`);
  if (item.dueMiles !== null) parts.push(`at ${fmtMiles(item.dueMiles)}`);
  return parts.length ? parts.join(' · ') : null;
}

// ---------------------------------------------------------------- Upcoming

test.describe('4Runner Upcoming', () => {
  const schedule = fourRunner.upcoming.filter(u => u.kind === 'schedule');
  const dealer = fourRunner.upcoming.find(u => u.kind === 'dealer')!;
  const watch = fourRunner.upcoming.filter(u => u.kind === 'recommendation' && u.status === 'Watch');
  const plan = fourRunner.coverage.find(p => p.active && p.covers.includes('All'))!;

  test('fixture sanity: the acceptance values are in the data', () => {
    expect(schedule.length).toBeGreaterThan(0);
    expect(dealer.subtitle).toContain('Dec 25, 2026');
    expect(dealer.subtitle).toContain('40,000 mi');
    expect(dealer.dueMiles).toBe(40000);
    for (const word of [/tire/i, /brake/i, /filter/i]) expect(watch.some(w => word.test(w.title))).toBe(true);
    expect(plan).toBeTruthy();
  });

  test('shows the schedule rows, the dealer service, Watch items and coverage, as in the Sheet', async ({ page }) => {
    const c = await openVehicle(page, fourRunner);
    const up = c.getByRole('region', { name: 'Upcoming' });

    // Rows appear in the Sheet's order (Overdue first, then Due By) and nothing is recalculated.
    const titles = await up.locator('.up-row .up-title').allInnerTexts();
    expect(titles.slice(0, fourRunner.upcoming.length)).toEqual(fourRunner.upcoming.map(u => u.title));

    for (const item of schedule) {
      const row = upcomingRow(up, item.title);
      await expect(row).toHaveCount(1);
      await expect(row.locator('.up-due')).toHaveText(dueLine(item)!);
      await expect(row.locator('.badge').first()).toHaveText(item.status);
    }

    const dealerRow = upcomingRow(up, dealer.title);
    await expect(dealerRow).toContainText(dealer.subtitle!);
    await expect(dealerRow).toContainText('Dec 25, 2026');
    await expect(dealerRow).toContainText('40,000 mi');
    await expect(dealerRow.locator('.up-due')).toHaveText(dueLine(dealer)!);

    for (const w of watch) {
      const row = upcomingRow(up, w.title);
      await expect(row.locator('.badge').first()).toHaveText('Watch');
      await expect(row).toContainText('Keep an eye on');
    }

    // "Covered: <plan>" on every row the plan covers.
    const covered = fourRunner.upcoming.filter(u => u.coveredBy.includes(plan.name));
    expect(covered.length).toBeGreaterThan(0);
    for (const item of covered) {
      await expect(upcomingRow(up, item.title).getByText(`Covered: ${plan.name}`)).toBeVisible();
    }
  });

  test('a schedule row explains its interval and links to the last visit', async ({ page }) => {
    const item = schedule.find(s => s.schedule?.lastDoneVisitId)!;
    const s = item.schedule!;
    const c = await openVehicle(page, fourRunner);
    await upcomingRow(c.getByRole('region', { name: 'Upcoming' }), item.title).click();
    const sheet = page.getByRole('dialog', { name: item.title });
    await expect(sheet).toBeVisible();
    if (s.intervalSource) await expect(sheet.getByText(s.intervalSource)).toBeVisible();
    if (s.intervalMiles) await expect(sheet.getByText(new RegExp(`Every .*${esc(fmtMiles(s.intervalMiles))}`))).toBeVisible();
    await expect(sheet.getByText(`Covered: ${plan.name}`)).toBeVisible();
    await sheet.getByRole('link', { name: /See that visit/ }).click();
    const visit = fourRunner.visits.find(x => x.visitId === s.lastDoneVisitId)!;
    await expect(page).toHaveURL(new RegExp(`/visit/${esc(encodeURIComponent(visit.visitId))}$`));
    await expect(page.getByRole('dialog', { name: fmtDate(visit.date!) })).toBeVisible();
  });

  test('the dealer row opens with the shop’s numbers', async ({ page }) => {
    const c = await openVehicle(page, fourRunner);
    await upcomingRow(c.getByRole('region', { name: 'Upcoming' }), dealer.title).click();
    const sheet = page.getByRole('dialog', { name: dealer.title });
    await expect(sheet).toContainText(fmtDate(dealer.dueBy!));
    await expect(sheet).toContainText(fmtMiles(dealer.dueMiles!));
  });

  test('the no-history group starts collapsed', async ({ page }) => {
    const withNoHistory = vehicle(v => v.noHistory.length > 0, 'vehicle with No history rows');
    const c = await openVehicle(page, withNoHistory);
    const group = c.locator('details.nohistory');
    await expect(group).not.toHaveAttribute('open', /.*/);
    const first = withNoHistory.noHistory[0];
    await expect(group.locator('.up-title', { hasText: first.title })).toBeHidden();
    await group.getByText(/No service record yet/).click();
    await expect(group.locator('.up-title', { hasText: first.title })).toBeVisible();
  });
});

// ---------------------------------------------------------------- Service Journal

test.describe('Service Journal', () => {
  test('Highlander lists visits newest first, starting with its 2025-12-02 visit', async ({ page }) => {
    const first = highlander.visits[0];
    expect(first.date).toBe('2025-12-02');
    const c = await openVehicle(page, highlander);
    const journal = c.getByRole('region', { name: 'Service Journal' });
    const rows = journal.locator('.visit-row');
    const n = await rows.count();
    expect(n).toBeGreaterThan(1);
    const dates = await journal.locator('.visit-row .visit-date').allInnerTexts();
    expect(dates).toEqual(highlander.visits.slice(0, n).map(x => fmtDate(x.date!)));
    await expect(rows.first()).toContainText(first.location!);

    // Blank totals read "—"; a non-receipt source carries its tag.
    const blank = highlander.visits.slice(0, n).findIndex(x => x.invoiceTotal === null);
    expect(blank).toBeGreaterThanOrEqual(0);
    await expect(rows.nth(blank).locator('.visit-total')).toHaveText('—');
    const tagged = highlander.visits.slice(0, n).findIndex(x => x.sourceTag);
    if (tagged >= 0) await expect(rows.nth(tagged).locator('.tag')).toContainText(highlander.visits[tagged].sourceTag!);
    // No jargon in the list.
    await expect(journal).not.toContainText('RO #');
    await expect(journal).not.toContainText('Repair order');
  });

  test('a visit opens its services and its receipt in the viewer', async ({ page }) => {
    const x = highlander.visits[0];
    const c = await openVehicle(page, highlander);
    await c.getByRole('region', { name: 'Service Journal' }).locator('.visit-row').first().click();
    const sheet = page.getByRole('dialog', { name: fmtDate(x.date!) });
    await expect(sheet).toBeVisible();
    if (x.roNumber) await expect(sheet.locator('.kv-row', { hasText: 'Repair order' })).toContainText(x.roNumber);
    const services = sheet.getByRole('region', { name: 'Services' });
    for (const s of x.services) {
      await expect(services).toContainText(s.serviceType ?? s.description!);
      if (s.lineCost !== null) await expect(services).toContainText(fmtMoney(s.lineCost));
    }

    const docs = sheet.getByRole('region', { name: 'Documents' }).locator('.doc-row');
    await expect(docs).toHaveCount(x.documents.length);
    await docs.first().click();
    const viewer = page.getByRole('dialog', { name: x.documents[0].documentType ?? x.documents[0].fileName! });
    // The mock serves a tiny one-page PDF, drawn by pdf.js into a canvas (never an iframe).
    await expect(viewer.locator('canvas.dv-canvas')).toHaveCount(1, { timeout: 15_000 });
    await expect(viewer.locator('iframe, embed, object')).toHaveCount(0);
    await expect(viewer.getByRole('link', { name: 'Open in Google Drive' })).toHaveAttribute(
      'href', `https://drive.google.com/file/d/${encodeURIComponent(x.documents[0].fileId)}/view`,
    );
    await viewer.getByRole('button', { name: 'Zoom in' }).click();
    await expect(viewer.locator('.dv-zoom')).toHaveText('150%');
    await viewer.getByRole('button', { name: 'Done' }).click();
    await expect(viewer).toHaveCount(0);
    await expect(sheet).toBeVisible();
  });

  test('offline: a receipt viewed before opens from the phone; one never viewed says so', async ({ page, context }) => {
    const x = highlander.visits[0];
    expect(x.documents.length).toBeGreaterThan(1);
    await openVehicle(page, highlander, `/visit/${encodeURIComponent(x.visitId)}`);
    const sheet = page.getByRole('dialog', { name: fmtDate(x.date!) });
    const docs = sheet.getByRole('region', { name: 'Documents' }).locator('.doc-row');
    const first = page.getByRole('dialog', { name: x.documents[0].documentType! });

    await docs.first().click();
    await expect(first.locator('canvas.dv-canvas')).toHaveCount(1, { timeout: 15_000 });
    await first.getByRole('button', { name: 'Done' }).click();

    await context.setOffline(true);
    await docs.first().click();
    await expect(first.locator('canvas.dv-canvas')).toHaveCount(1, { timeout: 15_000 });
    await first.getByRole('button', { name: 'Done' }).click();

    await docs.nth(1).click();
    const second = page.getByRole('dialog', { name: x.documents[1].documentType! });
    await expect(second.getByText('This receipt isn’t saved on this phone yet. Connect to view it.')).toBeVisible();
    await expect(second.getByRole('link', { name: 'Open in Google Drive' })).toBeVisible();
    // Back online, it loads by itself.
    await context.setOffline(false);
    await expect(second.locator('canvas.dv-canvas')).toHaveCount(1, { timeout: 15_000 });
  });

  test('documents are PDF first, with "Pages missing", and notes sit behind Details', async ({ page }) => {
    const x = fourRunner.visits.find(v => v.notes && v.documents.some(d => d.complete === false))!;
    expect(x).toBeTruthy();
    await openVehicle(page, fourRunner, `/visit/${encodeURIComponent(x.visitId)}`);
    const sheet = page.getByRole('dialog', { name: fmtDate(x.date!) });
    const missing = x.documents.find(d => d.complete === false)!;
    await expect(sheet.locator('.doc-row', { hasText: missing.documentType ?? '' }).getByText('Pages missing')).toBeVisible();
    await expect(sheet.getByText(x.notes!)).toBeHidden();
    await sheet.getByText('Details', { exact: true }).click();
    await expect(sheet.getByText(x.notes!)).toBeVisible();

    // A visit with a merged PDF and page images lists the PDF first.
    const mixed = data.vehicles.flatMap(v => v.visits.map(visit => ({ v, visit })))
      .find(({ visit }) => visit.documents.some(d => d.kind === 'pdf') && visit.documents.some(d => d.kind === 'image'))!;
    await page.goto(`./#/v/${encodeURIComponent(mixed.v.name)}/visit/${encodeURIComponent(mixed.visit.visitId)}`);
    const mixedSheet = page.getByRole('dialog', { name: fmtDate(mixed.visit.date!) });
    await expect(mixedSheet.locator('.doc-row').first()).toContainText('PDF');
    await expect(mixedSheet.locator('.doc-row').last()).toContainText('Image');
  });

  test('BMW visits from before the purchase carry "Before we owned it"', async ({ page }) => {
    const before = bmw.visits.filter(x => x.beforeOwnership);
    expect(before.length).toBeGreaterThan(0);
    const c = await openVehicle(page, bmw);
    const journal = c.getByRole('region', { name: 'Service Journal' });
    const rows = journal.locator('.visit-row');
    const n = await rows.count();
    for (let i = 0; i < n; i++) {
      const x = bmw.visits[i];
      const tag = rows.nth(i).locator('.tag', { hasText: 'Before we owned it' });
      await expect(tag).toHaveCount(x.beforeOwnership ? 1 : 0);
      if (x.sourceTag) await expect(rows.nth(i).locator('.tag', { hasText: x.sourceTag })).toHaveCount(1);
    }
  });
});

// ---------------------------------------------------------------- header, banner, quick actions

test.describe('card header and quick actions', () => {
  test('header shows name, plate and the estimated mileage; the photo is contained', async ({ page }) => {
    const c = await openVehicle(page, fourRunner);
    await expect(c.getByRole('heading', { name: fourRunner.name, level: 2 })).toBeVisible();
    await expect(c.locator('.vcard-header')).toContainText(fourRunner.plate!);
    await expect(c.locator('.vcard-miles')).toContainText(`~${fmtMiles(fourRunner.estMileage!)}`);
    const img = c.locator('.vphoto-img');
    await expect(img).toBeVisible();
    expect(await img.evaluate(el => getComputedStyle(el).objectFit)).toBe('contain');
  });

  test('a "park it" recall puts "Do not drive until repaired" in the attention banner', async ({ page }) => {
    expect(jeep.recalls.some(r => r.parkIt && r.status === 'New')).toBe(true);
    const c = await openVehicle(page, jeep);
    const banner = c.getByRole('region', { name: 'Needs attention' });
    await expect(banner.locator('.attn-danger')).toContainText('Do not drive until repaired');
    const recallItem = jeep.upcoming.find(u => u.kind === 'recall' && jeep.recalls.find(r => r.campaignNumber === u.recall?.campaignNumber)?.parkIt)!;
    await expect(upcomingRow(c.getByRole('region', { name: 'Upcoming' }), recallItem.title)).toContainText('Do not drive until repaired');
    await banner.locator('.attn-danger').click();
    await expect(page.getByRole('dialog', { name: 'Recalls' })).toBeVisible();
  });

  test('OEM app button: opens the link, keeps the App Store link, and offers it if nothing opened', async ({ page }) => {
    const app = bmw.oemApp!;
    expect(app?.storeLink).toBeTruthy();
    const c = await openVehicle(page, bmw);
    const store = c.getByRole('link', { name: `Don’t have the ${app.name} app? Get it on the App Store` });
    await expect(store).toHaveAttribute('href', app.storeLink!);
    await expect(store).toHaveText('Don’t have the app?');

    await c.getByRole('button', { name: `Open ${app.name}` }).click();
    // The scheme can't open here, so ~2 s later the page is still visible and the fallback appears.
    const fallback = c.getByRole('link', { name: `Didn’t open? Get ${app.name} on the App Store` });
    await expect(fallback).toBeVisible({ timeout: 6_000 });
    await expect(fallback).toHaveAttribute('href', app.storeLink!);
    await expect(store).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`#/v/${esc(encodeURIComponent(bmw.name))}$`));
  });

  test('OEM app button only where the vehicle has one', async ({ page }) => {
    const withApp = data.vehicles.filter(v => v.oemApp);
    const without = data.vehicles.find(v => !v.oemApp)!;
    expect(withApp.length).toBeGreaterThan(0);
    await openVehicle(page, withApp[0]);
    for (const v of withApp) {
      await page.getByRole('button', { name: `Show ${v.name}` }).click();
      await expect(card(page, v).getByRole('button', { name: `Open ${v.oemApp!.name}` })).toBeVisible();
      await expect(card(page, v).getByText('Don’t have the app?')).toHaveCount(v.oemApp!.storeLink ? 1 : 0);
    }
    await page.getByRole('button', { name: `Show ${without.name}` }).click();
    await expect(card(page, without).getByRole('button', { name: /^Open / })).toHaveCount(0);
  });
});

// ---------------------------------------------------------------- panels

test.describe('panels', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('Vehicle Basics: "Not set" for blanks, copy VIN, long-press copy', async ({ page }) => {
    const blankKey = (Object.keys(bmw.basics) as (keyof Vehicle['basics'])[]).find(k => bmw.basics[k] === null);
    expect(blankKey).toBeTruthy();
    const c = await openVehicle(page, bmw);
    await c.getByRole('link', { name: 'Vehicle Basics' }).click();
    const sheet = page.getByRole('dialog', { name: 'Vehicle Basics' });
    await expect(sheet.locator('.kv-row', { hasText: 'Oil capacity' }).locator('.kv-value')).toHaveText('Not set');
    await expect(sheet.locator('.kv-row', { hasText: 'VIN' }).locator('.kv-value')).toHaveText(bmw.vin!);

    await sheet.getByRole('button', { name: 'Copy VIN' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Copied' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(bmw.vin);

    // Long-press (hold ~0.5 s) any value to copy it.
    const oil = sheet.locator('.kv-row').filter({ has: page.locator('.kv-label', { hasText: /^Oil$/ }) }).locator('.kv-value');
    await expect(oil).toHaveText(bmw.basics.oilSpec!);
    await page.evaluate(() => navigator.clipboard.writeText(''));
    const box = (await oil.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(bmw.basics.oilSpec);
  });

  test('Costs shows the totals and the visits with no total', async ({ page }) => {
    const v = highlander;
    await openVehicle(page, v, '/costs');
    const sheet = page.getByRole('dialog', { name: 'Costs' });
    await expect(sheet.locator('.stat', { hasText: 'Since purchase' })).toContainText(fmtMoney(v.costs.sincePurchase));
    await expect(sheet.locator('.stat', { hasText: 'Last 12 months' })).toContainText(fmtMoney(v.costs.last12Months));
    await expect(sheet).toContainText(`${v.costs.visitsWithoutTotal} visits have no total recorded`);
    await expect(sheet.getByRole('img', { name: /Spend per year/ })).toBeVisible();
    for (const t of v.costs.byServiceType) await expect(sheet).toContainText(t.serviceType);
  });

  test('Wear shows the latest readings and projections', async ({ page }) => {
    const v = highlander;
    await openVehicle(page, v, '/wear');
    const sheet = page.getByRole('dialog', { name: 'Wear' });
    const tread = v.wear.tread!;
    const block = sheet.getByRole('region', { name: tread.label });
    await expect(block.locator('.wear-value')).toHaveText(`${tread.latest.value}${tread.unit}`);
    await expect(block).toContainText(`Replace at ${tread.replacementPoint}${tread.unit}`);
    const single = [v.wear.tread, v.wear.brakeFront, v.wear.brakeRear].find(w => w?.note === 'One reading so far');
    if (single) await expect(sheet.getByRole('region', { name: single.label })).toContainText('One reading so far');
    await expect(block.getByRole('img', { name: /readings by mileage/ })).toBeVisible();
  });

  test('Registration shows the expiry and opens the scanned registration', async ({ page }) => {
    const v = highlander;
    expect(v.registration.expires && v.registration.fileId).toBeTruthy();
    await openVehicle(page, v, '/registration');
    const sheet = page.getByRole('dialog', { name: 'Registration' });
    await expect(sheet.locator('.kv-row', { hasText: 'Expires' })).toContainText(fmtDate(v.registration.expires!));
    if (v.registration.daysLeft! < 0) {
      await expect(sheet.locator('.badge')).toHaveText('Overdue');
      await expect(sheet).toContainText(`Expired ${-v.registration.daysLeft!} days ago`);
    }
    await sheet.getByRole('button', { name: /Open the scanned registration/ }).click();
    const viewer = page.getByRole('dialog', { name: 'Scanned registration' });
    await expect(viewer.locator('canvas.dv-canvas')).toHaveCount(1, { timeout: 15_000 });
    await viewer.getByRole('button', { name: 'Done' }).click();
    await expect(viewer).toHaveCount(0);
    await expect(sheet).toBeVisible();
  });

  test('Recalls: may apply to this model, VIN check link and copy VIN', async ({ page }) => {
    const v = jeep;
    await openVehicle(page, v, '/recalls');
    const sheet = page.getByRole('dialog', { name: 'Recalls' });
    await expect(sheet).toContainText('May apply to this model');
    for (const r of v.recalls) await expect(sheet).toContainText(`Campaign ${r.campaignNumber}`);
    await expect(sheet.locator('.recall-warning', { hasText: 'Do not drive until repaired' })).toBeVisible();
    await expect(sheet.getByRole('link', { name: /Check your VIN on nhtsa.gov/ }))
      .toHaveAttribute('href', `${appConfig.nhtsaRecallsUrl}?vin=${v.vin}`);
    await sheet.getByRole('button', { name: /Copy VIN/ }).click();
    await expect(page.getByRole('status').filter({ hasText: 'VIN copied' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(v.vin);
  });

  test('Recalls: Done moves a recall out of New and off Upcoming; Mark as new puts it back', async ({ page }) => {
    const v = jeep;
    const r = v.recalls.find(x => x.status === 'New')!;
    const item = v.upcoming.find(u => u.recall?.campaignNumber === r.campaignNumber)!;
    expect(item).toBeTruthy();
    const c = await openVehicle(page, v, '/recalls');
    const sheet = page.getByRole('dialog', { name: 'Recalls' });
    const newList = sheet.locator('section[aria-labelledby="recalls-new"]');
    const oldList = sheet.locator('section[aria-labelledby="recalls-old"]');
    const recall = (list: Locator) => list.locator('.recall-card', { hasText: `Campaign ${r.campaignNumber}` });

    await recall(newList).getByRole('button', { name: /recall done$/ }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Marked done' })).toBeVisible();
    await expect(recall(newList)).toHaveCount(0);
    await expect(recall(oldList).locator('.badge')).toHaveText('Done');
    await expect(recall(oldList)).toContainText(`Marked Done by ${owner.name} on`);

    // Off Upcoming once the refresh comes back.
    await sheet.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(upcomingRow(c.getByRole('region', { name: 'Upcoming' }), item.title)).toHaveCount(0);

    // And back again.
    await c.getByRole('region', { name: 'More' }).getByRole('link', { name: /Recalls/ }).click();
    await recall(oldList).getByRole('button', { name: /as new again$/ }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Marked as new' })).toBeVisible();
    await expect(recall(newList).locator('.badge')).toHaveText('New');
    await expect(recall(newList).getByRole('button', { name: /as not applying to this vehicle$/ })).toBeVisible();
  });

  test('Coverage lists active plans with what they cover', async ({ page }) => {
    const v = fourRunner;
    const c = await openVehicle(page, v);
    await c.getByRole('region', { name: 'More' }).getByRole('link', { name: /Coverage/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Coverage' });
    for (const p of v.coverage) {
      const row = sheet.locator('.plan-row', { hasText: p.name });
      await expect(row.locator('.badge')).toHaveText(p.active ? 'Active' : 'Ended');
      if (p.covers.includes('All')) await expect(row).toContainText('Covers everything');
    }
  });

  test('Export builds the PDF before the tap and toggles pre-ownership history', async ({ page }) => {
    const v = bmw;
    const owned = v.visits.filter(x => !x.beforeOwnership).length;
    await openVehicle(page, v, '/export');
    const sheet = page.getByRole('dialog', { name: 'Service history' });
    const status = sheet.locator('.export-status');
    await expect(status).toContainText(`${owned} ${owned === 1 ? 'visit' : 'visits'}`, { timeout: 15_000 });
    await expect(sheet.locator('.export-visit')).toHaveCount(owned);
    await expect(sheet.locator('.export-preview')).not.toContainText(v.visits.find(x => x.notes)?.notes ?? '\u0000');
    // No share sheet on desktop Chromium: a real download link to the ready-made PDF.
    const dl = sheet.getByRole('link', { name: 'Download PDF' });
    await expect(dl).toHaveAttribute('download', /service history\.pdf$/);
    await expect(dl).toHaveAttribute('href', /^blob:/);

    await sheet.getByRole('switch', { name: /Include history before we owned it/ }).click();
    await expect(status).toContainText(`${v.visits.length} visits`, { timeout: 15_000 });
    await expect(sheet.locator('.export-visit')).toHaveCount(v.visits.length);
    await expect(sheet.locator('.export-preview')).toContainText('Before we owned it');
  });
});

// ---------------------------------------------------------------- odometer

test.describe('Update Odometer', () => {
  test('blocks a reading below the latest, asks about a very high one, and saves a valid one', async ({ page }) => {
    const v = fourRunner;
    const c = await openVehicle(page, v);
    await c.getByRole('link', { name: 'Update Odometer' }).click();
    const sheet = page.getByRole('dialog', { name: 'Update Odometer' });
    const field = sheet.getByLabel('Odometer reading (miles)');
    await expect(field).toHaveValue('');
    await expect(sheet).toContainText(`Estimated ~${fmtMiles(v.estMileage!)}`);

    await field.fill(String(v.latestOdometer! - 500));
    await sheet.getByRole('button', { name: 'Save reading' }).click();
    const alert = sheet.getByRole('alert');
    await expect(alert).toContainText('lower than the last reading');
    await expect(alert).toContainText(fmtMiles(v.latestOdometer!));
    await expect(alert).toContainText(fmtDate(v.latestOdometerDate!));
    await expect(sheet.getByRole('button', { name: 'Save reading' })).toBeDisabled();

    const high = v.estMileage! + 6000;
    await field.fill(String(high));
    await sheet.getByRole('button', { name: 'Save reading' }).click();
    await expect(sheet.getByRole('alert')).toContainText('Are you sure?');
    await sheet.getByRole('button', { name: 'Change it' }).click();

    const good = v.latestOdometer! + 480;
    await field.fill(String(good));
    await sheet.getByRole('button', { name: 'Save reading' }).click();
    await expect(page.getByRole('status').filter({ hasText: `Odometer saved: ${fmtMiles(good)}` })).toBeVisible();
    await expect(sheet).toHaveCount(0);
    // The refreshed bootstrap moves the estimate.
    await expect(c.locator('.vcard-miles')).toContainText(`~${fmtMiles(good)}`);
  });
});
