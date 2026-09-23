/**
 * Pending deep links from notification taps.
 *
 * On older iOS, clients.openWindow(url) often opens the home-screen app
 * without navigating to the URL. So the service worker's notificationclick
 * handler first stores the URL in IndexedDB (kv › pendingDeepLink), then posts
 * {type: 'navigate', url} to an open window. The app reads and clears the
 * pending link at start-up and whenever it comes back to the foreground, and
 * also listens for the message. Only in-app hash routes are followed.
 */

import { db, kvGet } from '../lib/db';
import { PENDING_DEEPLINK_KEY, type PendingDeepLink } from '../lib/push';
import { go } from './router';
import { authState } from './store';

/** A link older than this (the tap happened long ago) is ignored. */
export const DEEPLINK_MAX_AGE_MS = 60 * 60 * 1000;

/** The app's own URL, e.g. "https://example.github.io/VehicleTracker/". */
export function appBase(): string {
  return location.origin + import.meta.env.BASE_URL;
}

/**
 * Absolute URL (or bare hash) → the in-app hash route to open, or null when
 * the link isn't one of ours (another site, another path, sign-in fragments,
 * anything that isn't "#/…").
 */
export function deepLinkHash(url: unknown, base: string): string | null {
  if (typeof url !== 'string' || !url) return null;
  let hash: string;
  if (url.startsWith('#')) {
    hash = url;
  } else {
    try {
      const u = new URL(url, base);
      const b = new URL(base);
      if (u.origin !== b.origin) return null;
      const basePath = b.pathname.endsWith('/') ? b.pathname : b.pathname + '/';
      if (u.pathname !== basePath && u.pathname !== basePath + 'index.html' && u.pathname + '/' !== basePath) return null;
      hash = u.hash;
    } catch {
      return null;
    }
  }
  if (!hash || hash === '#' || hash === '#/') return '#/';
  if (!/^#\/[^\s<>"']*$/.test(hash)) return null;
  if (/(?:^|[&?#/])(?:id_token|access_token|code|state|error)=/.test(hash)) return null;
  return hash;
}

/** Reads and clears the pending link. Returns the hash to open, or null. */
export async function takePendingDeepLink(now = Date.now(), base = appBase()): Promise<string | null> {
  const pending = await kvGet<PendingDeepLink>(PENDING_DEEPLINK_KEY);
  if (!pending) return null;
  await clearPendingDeepLink();
  if (typeof pending.at !== 'number' || now - pending.at > DEEPLINK_MAX_AGE_MS || pending.at - now > 60000) return null;
  return deepLinkHash(pending.url, base);
}

export async function clearPendingDeepLink(): Promise<void> {
  try {
    await (await db()).delete('kv', PENDING_DEEPLINK_KEY);
  } catch {
    /* ignore */
  }
}

/** Navigates to an in-app hash unless we're already there. */
export function openDeepLink(hash: string): boolean {
  if (location.hash === hash || (hash === '#/' && (location.hash === '' || location.hash === '#'))) return false;
  go(hash);
  return true;
}

let checking = false;

/** Opens the pending link, if any (only when signed in; otherwise it waits). */
export async function applyPendingDeepLink(): Promise<void> {
  if (authState.value !== 'signedIn' || checking) return;
  checking = true;
  try {
    const hash = await takePendingDeepLink();
    if (hash) openDeepLink(hash);
  } finally {
    checking = false;
  }
}

let started = false;

/** Called once after sign-in. */
export function startDeepLinks(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
      const data = e.data as { type?: string; url?: unknown } | null;
      if (!data || data.type !== 'navigate' || authState.value !== 'signedIn') return;
      const hash = deepLinkHash(data.url, appBase());
      void clearPendingDeepLink();
      if (hash) openDeepLink(hash);
    });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void applyPendingDeepLink();
  });
  void applyPendingDeepLink();
}
