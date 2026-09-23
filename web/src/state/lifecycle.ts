/**
 * App-wide background work, started once from main.tsx:
 * - after each sign-in: the scan upload queue (receipts), the odometer queue,
 *   push subscription checks, pending deep links from notification taps, and
 *   (first home-screen launch) a request for persistent storage;
 * - when the app comes back to the foreground: refresh data older than
 *   5 minutes (iOS keeps home-screen apps suspended for a long time).
 */

import { effect, untracked } from '@preact/signals';
import { local } from '../lib/db';
import { standalone } from '../lib/platform';
import { startUploadQueue } from '../receipts';
import { applyPendingDeepLink, startDeepLinks } from './deeplink';
import { dismissOdometerNotice, flushOdometer, startOdometerQueue } from './odometer';
import { pushEndpoint, pushNeedsEnable, pushSubscribed, startPush, syncPush } from './push';
import { authState, bootstrapFetchedAt, refresh } from './store';

export const STALE_AFTER_MS = 5 * 60 * 1000;
const PERSIST_KEY = 'app.persistRequested';

let uploadsStarted = false;
let lastState: string | null = null;

function onSignedIn(): void {
  if (!uploadsStarted) {
    uploadsStarted = true;
    try {
      startUploadQueue();
    } catch (e) {
      console.error('Upload queue failed to start', e);
    }
  }
  startOdometerQueue();
  startPush();
  startDeepLinks();
  // Each later sign-in (after a sign-out) re-checks too.
  void flushOdometer();
  void syncPush();
  void applyPendingDeepLink();
  void requestPersistentStorage();
}

function onSignedOut(): void {
  pushSubscribed.value = false;
  pushEndpoint.value = null;
  pushNeedsEnable.value = false;
  dismissOdometerNotice();
}

/** Asks once, on the first home-screen launch, for storage the OS won't evict. */
export async function requestPersistentStorage(): Promise<void> {
  if (!standalone.value || local.get(PERSIST_KEY) === '1') return;
  local.set(PERSIST_KEY, '1');
  try {
    await navigator.storage?.persist?.();
  } catch {
    /* not supported */
  }
}

let started = false;

export function startLifecycle(): void {
  if (started || typeof window === 'undefined') return;
  started = true;

  effect(() => {
    const s = authState.value;
    if (s === lastState) return;
    const prev = lastState;
    lastState = s;
    untracked(() => {
      if (s === 'signedIn') onSignedIn();
      else if (prev === 'signedIn' && (s === 'signedOut' || s === 'notFamily')) onSignedOut();
    });
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || authState.value !== 'signedIn') return;
    const at = bootstrapFetchedAt.value ?? 0;
    if (Date.now() - at > STALE_AFTER_MS) void refresh();
  });
}
