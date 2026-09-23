import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';

/** People in the synthetic fixture (web/src/mock/index.json, from `npm run fixture`). */
export interface MockUser { email: string; name: string; file: string }

export function mockUsers(): MockUser[] {
  const raw = readFileSync(new URL('../../src/mock/index.json', import.meta.url), 'utf8');
  return (JSON.parse(raw) as { users: MockUser[] }).users;
}

export function mockUser(name: string): MockUser {
  const u = mockUsers().find(x => x.name.toLowerCase() === name.toLowerCase());
  if (!u) throw new Error(`No fixture user named ${name}`);
  return u;
}

/** The fixture's system owner (App Users row flagged as owner), else the first user. */
export function ownerUser(): MockUser {
  return mockUsers()[0];
}

/**
 * Starts the app already signed in as a fixture person (mock sessions are
 * "mock.<base64 email>", see src/api/mock.ts). Pass `hash` to deep-link.
 */
export async function signInAs(page: Page, name: string, hash = '#/'): Promise<void> {
  const u = mockUser(name);
  const token = `mock.${Buffer.from(u.email.toLowerCase()).toString('base64')}`;
  await page.addInitScript(t => {
    try { localStorage.setItem('vehicles.session', t); } catch { /* ignore */ }
  }, token);
  await page.goto('./' + hash);
}
