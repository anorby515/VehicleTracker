/**
 * Service worker registration with a "New version available. Tap to refresh."
 * prompt instead of silently updating mid-use.
 *
 * iOS specifics (research, Sep 2026):
 * - iOS often installs the new worker before the app is even opened, so it is
 *   already in registration.waiting at start-up: check for it, not just for
 *   'waiting' events.
 * - Resuming a suspended home-screen app isn't a navigation, so nothing checks
 *   for updates: call registration.update() when the app comes to the
 *   foreground (at most every 30 minutes).
 * - updateViaCache: 'none' so the HTTP cache never serves a stale sw.js.
 */

import { signal } from '@preact/signals';
import type { Workbox } from 'workbox-window';

export const updateAvailable = signal(false);
export let swRegistration: ServiceWorkerRegistration | null = null;

const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
let wb: Workbox | null = null;
let lastCheck = 0;
let reloading = false;
let reloaded = false;

function reloadOnce(): void {
  if (reloaded) return;
  reloaded = true;
  location.reload();
}

function markWaiting(reg: ServiceWorkerRegistration | null | undefined): void {
  // A waiting worker only means an update when a current one is in control.
  if (reg?.waiting && navigator.serviceWorker.controller) updateAvailable.value = true;
}

export function initServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || import.meta.env.DEV) return;
  void import('workbox-window').then(async ({ Workbox }) => {
    const base = import.meta.env.BASE_URL;
    wb = new Workbox(base + 'sw.js', { scope: base, updateViaCache: 'none' });
    wb.addEventListener('waiting', () => { updateAvailable.value = true; });
    wb.addEventListener('controlling', e => {
      // Reload only when we asked for the update (not on first install).
      if (e.isUpdate && reloading) reloadOnce();
    });
    try {
      const reg = await wb.register({ immediate: true });
      swRegistration = reg ?? null;
      markWaiting(reg);
      lastCheck = Date.now();
    } catch {
      /* private mode or storage disabled: the app still works online */
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !swRegistration) return;
      markWaiting(swRegistration);
      if (Date.now() - lastCheck < UPDATE_CHECK_INTERVAL_MS) return;
      lastCheck = Date.now();
      swRegistration.update().then(() => markWaiting(swRegistration)).catch(() => {});
    });
  });
}

/** "Tap to refresh": activate the waiting worker, then reload once it controls the page. */
export async function reloadToUpdate(): Promise<void> {
  const waiting = swRegistration?.waiting;
  if (!waiting) {
    reloadOnce();
    return;
  }
  reloading = true;
  navigator.serviceWorker.addEventListener('controllerchange', reloadOnce, { once: true });
  waiting.postMessage({ type: 'SKIP_WAITING' });
  // If the switch never happens (the worker was replaced meanwhile), reload anyway.
  setTimeout(reloadOnce, 4000);
}
