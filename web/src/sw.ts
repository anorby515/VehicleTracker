/// <reference lib="webworker" />
/**
 * Service worker (vite-plugin-pwa injectManifest → dist/sw.js).
 *
 * Caching
 * - Hashed build assets are precached (self.__WB_MANIFEST).
 * - Page loads are network-first with a 3 s timeout, falling back to the
 *   precached index.html, so the app opens with no signal and still picks up
 *   new deploys promptly. Page responses aren't cached separately, so the
 *   shell always matches this worker's precached assets.
 * - OpenCV.js (~10 MB) and the pdf.js worker are cached on first use.
 * - Nothing else is intercepted: never non-GET requests, and never other
 *   origins (the App API on script.google.com / script.googleusercontent.com,
 *   Google sign-in, Drive).
 *
 * Push (docs/API.md › Push)
 * - Every push shows a notification, even a malformed one: iOS revokes the
 *   subscription of an app that receives a push and shows nothing.
 * - Notification taps store a pending deep link first, then message or focus
 *   an open window, or open one (iOS's openWindow often ignores the URL).
 */

import { ExpirationPlugin } from 'workbox-expiration';
import { matchPrecache, precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkFirst } from 'workbox-strategies';
import { kvSet } from './lib/db';
import { PENDING_DEEPLINK_KEY, type PendingDeepLink, parsePushPayload, resolveNotificationUrl } from './lib/push';

declare const self: ServiceWorkerGlobalScope;

const SCOPE = self.registration.scope; // "https://…/VehicleTracker/"
const sameOrigin = (url: URL) => url.origin === self.location.origin;

// ---------------------------------------------------------------- page loads (registered first so it wins over the precache route)

registerRoute(
  ({ request, url }) => request.mode === 'navigate' && sameOrigin(url) && url.pathname.startsWith(new URL(SCOPE).pathname),
  new NetworkFirst({
    cacheName: 'pages',
    networkTimeoutSeconds: 3,
    plugins: [
      // Never store page responses: the fallback is always this worker's own index.html.
      { cacheWillUpdate: async () => null },
      { cachedResponseWillBeUsed: async ({ cachedResponse }) => cachedResponse ?? (await matchPrecache('index.html')) ?? null },
    ],
  }),
);

// ---------------------------------------------------------------- precache (hashed assets, index.html, icons, manifest)

precacheAndRoute(self.__WB_MANIFEST);

// ---------------------------------------------------------------- big libraries, cached on first use

registerRoute(
  ({ url }) => sameOrigin(url) && url.pathname.includes('/vendor/opencv/'),
  new CacheFirst({
    cacheName: 'opencv',
    plugins: [new ExpirationPlugin({ maxEntries: 2, purgeOnQuotaError: true })],
  }),
);

registerRoute(
  ({ url }) => sameOrigin(url) && /pdf\.worker/.test(url.pathname),
  new CacheFirst({
    cacheName: 'pdfjs-worker',
    plugins: [new ExpirationPlugin({ maxEntries: 3, purgeOnQuotaError: true })],
  }),
);

// ---------------------------------------------------------------- lifecycle

self.addEventListener('message', event => {
  const data = event.data as { type?: string } | null;
  if (data?.type === 'SKIP_WAITING') void self.skipWaiting();
});

// ---------------------------------------------------------------- push

self.addEventListener('push', event => {
  // Parse synchronously and show straight away: no network before showNotification.
  let text: string | null = null;
  try {
    text = event.data ? event.data.text() : null;
  } catch {
    text = null;
  }
  const msg = parsePushPayload(text, SCOPE);
  const options: NotificationOptions = { body: msg.body, data: { url: msg.url } };
  if (msg.tag) options.tag = msg.tag;
  event.waitUntil((async () => {
    await self.registration.showNotification(msg.title, options);
    if (msg.badge !== undefined) {
      const nav = self.navigator as WorkerNavigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
      try {
        if (msg.badge > 0) await nav.setAppBadge?.(msg.badge);
        else await nav.clearAppBadge?.();
      } catch {
        /* badges off */
      }
    }
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const raw = (event.notification.data as { url?: unknown } | null)?.url;
  const url = resolveNotificationUrl(raw, SCOPE);
  event.waitUntil((async () => {
    // 1. Remember it first, so the app finds it even if the steps below fail.
    const pending: PendingDeepLink = { url, at: Date.now() };
    await kvSet(PENDING_DEEPLINK_KEY, pending);
    // 2. Reuse an open window.
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = windows.find(c => c.url.startsWith(SCOPE)) ?? windows[0];
    if (client) {
      client.postMessage({ type: 'navigate', url });
      try {
        await client.focus();
      } catch {
        try { await client.navigate(url); } catch { /* the app reads the pending link when it's next visible */ }
      }
      return;
    }
    // 3. Otherwise open the app.
    await self.clients.openWindow(url);
  })());
});
