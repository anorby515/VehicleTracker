/**
 * Web Push on the iPhone home-screen app (spec 9; docs/API.md › Push).
 *
 * - Only offered in the home-screen app (standalone) where PushManager exists,
 *   and only when app.config.json has a VAPID public key.
 * - enablePush() must be called straight from the tap handler: it calls
 *   pushManager.subscribe() synchronously (no await before it), using a
 *   registration made ready beforehand, or iOS refuses the permission prompt.
 * - iOS never fires pushsubscriptionchange, so every launch checks
 *   getSubscription(): a lost subscription is renewed (when permission is
 *   still granted) and a changed endpoint is re-posted to the API.
 * - The app badge shows the number of Overdue items on the person's own vehicles.
 */

import { computed, effect, signal } from '@preact/signals';
import { ApiFailure, NetworkError, call } from '../api/client';
import type { NotificationEvent, NotificationPrefs } from '../api/types';
import { config } from '../config';
import { local } from '../lib/db';
import { deviceLabel, standalone } from '../lib/platform';
import { overdueCount, setBadge, vapidKeyBytes } from '../lib/push';
import { bootstrap } from './store';

/** Last endpoint successfully posted to the API (cleared with the rest on sign-out). */
const ENDPOINT_KEY = 'vehicles.push.endpoint';
const CARD_DISMISSED_KEY = 'vehicles.push.cardDismissed';
/** The person turned notifications off in the app: don't silently resubscribe. Survives sign-out. */
const USER_OFF_KEY = 'app.pushOff';

const applicationServerKey = vapidKeyBytes(config.vapidPublicKey);

export type PushSupport =
  | 'ok'
  | 'not-installed'   // Safari tab: Add to Home Screen first
  | 'unsupported'     // no PushManager (iOS before 16.4)
  | 'not-configured'; // no VAPID key in app.config.json yet

function hasPushApis(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function readPermission(): NotificationPermission | 'unsupported' {
  try {
    return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  } catch {
    return 'unsupported';
  }
}

export const pushSupport = computed<PushSupport>(() => {
  if (!standalone.value) return 'not-installed';
  if (!hasPushApis()) return 'unsupported';
  if (!applicationServerKey) return 'not-configured';
  return 'ok';
});

export const pushPermission = signal<NotificationPermission | 'unsupported'>(readPermission());
/** This device has an active subscription. */
export const pushSubscribed = signal(false);
export const pushEndpoint = signal<string | null>(local.get(ENDPOINT_KEY));
export const pushBusy = signal(false);
/** The last problem turning notifications on or off, in plain words. */
export const pushError = signal<string | null>(null);
/** A lost subscription couldn't be renewed silently: ask again with the card. */
export const pushNeedsEnable = signal(false);
export const pushCardDismissed = signal(local.get(CARD_DISMISSED_KEY) === '1');

/** Show the "Turn on notifications" card on the main screen. */
export const showPushCard = computed(() =>
  pushSupport.value === 'ok' &&
  !pushSubscribed.value &&
  ((pushPermission.value === 'default' && !pushCardDismissed.value) || pushNeedsEnable.value),
);

export function dismissPushCard(): void {
  pushCardDismissed.value = true;
  pushNeedsEnable.value = false;
  local.set(CARD_DISMISSED_KEY, '1');
}

/** The subscription endpoint on this device, for signOut(endpoint). */
export function currentPushEndpoint(): string | undefined {
  return pushEndpoint.value ?? undefined;
}

let readyReg: ServiceWorkerRegistration | null = null;

/** Resolves the service worker registration ahead of any tap (subscribe must not wait). */
function prepareRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!hasPushApis()) return Promise.resolve(null);
  return navigator.serviceWorker.ready.then(r => { readyReg = r; return r; });
}

async function postSubscription(sub: PushSubscription): Promise<void> {
  const json = sub.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) throw new Error('The subscription is missing its keys.');
  await call('subscribePush', {
    subscription: { endpoint: json.endpoint, expirationTime: json.expirationTime ?? null, keys: { p256dh, auth } },
    deviceLabel: deviceLabel(),
  });
  local.set(ENDPOINT_KEY, json.endpoint);
}

function describeError(e: unknown): string {
  if (e instanceof NetworkError) return 'No connection. Try again when you’re online.';
  if (e instanceof ApiFailure) return e.message;
  const name = (e as { name?: string } | null)?.name;
  if (name === 'NotAllowedError') {
    return pushPermission.value === 'denied'
      ? 'Notifications are turned off for this app in iPhone Settings.'
      : 'Notifications weren’t allowed.';
  }
  return e instanceof Error ? e.message : 'Something went wrong.';
}

/**
 * Turns notifications on. CALL DIRECTLY FROM A TAP HANDLER: subscribe() runs
 * synchronously here so iOS keeps the user gesture for its permission prompt.
 */
export function enablePush(): Promise<boolean> {
  pushError.value = null;
  const reg = readyReg;
  if (pushSupport.value !== 'ok' || !reg || !applicationServerKey) {
    pushError.value = pushSupport.value === 'not-installed'
      ? 'Add the app to your Home Screen first.'
      : 'Notifications aren’t available yet. Try again in a moment.';
    void prepareRegistration();
    return Promise.resolve(false);
  }
  let pending: Promise<PushSubscription>;
  try {
    pending = reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
  } catch (e) {
    pushError.value = describeError(e);
    return Promise.resolve(false);
  }
  pushBusy.value = true;
  return pending
    .then(async sub => {
      pushPermission.value = readPermission();
      pushSubscribed.value = true;
      pushEndpoint.value = sub.endpoint;
      pushNeedsEnable.value = false;
      local.remove(USER_OFF_KEY);
      try {
        await postSubscription(sub);
      } catch (e) {
        pushError.value = `Notifications are on for this ${deviceLabel()}, but the app couldn’t tell the server yet (${describeError(e)}). It will try again next time you open the app.`;
      }
      return true;
    })
    .catch(e => {
      pushPermission.value = readPermission();
      pushError.value = describeError(e);
      return false;
    })
    .finally(() => { pushBusy.value = false; });
}

/** Turns notifications off on this device. */
export async function disablePush(): Promise<void> {
  pushError.value = null;
  pushBusy.value = true;
  try {
    const reg = readyReg ?? (await prepareRegistration());
    const sub = await reg?.pushManager.getSubscription();
    const endpoint = sub?.endpoint ?? pushEndpoint.value;
    try { await sub?.unsubscribe(); } catch { /* already gone */ }
    local.set(USER_OFF_KEY, '1');
    local.remove(ENDPOINT_KEY);
    pushSubscribed.value = false;
    pushEndpoint.value = null;
    if (endpoint) {
      try { await call('unsubscribePush', { endpoint }); } catch { /* the API marks dead endpoints itself */ }
    }
  } catch (e) {
    pushError.value = describeError(e);
  } finally {
    pushBusy.value = false;
  }
}

/**
 * Every launch after sign-in: renew a lost subscription and re-post a changed
 * endpoint (iOS has no pushsubscriptionchange event).
 */
export async function syncPush(): Promise<void> {
  pushPermission.value = readPermission();
  if (pushSupport.value !== 'ok' || !applicationServerKey) return;
  const reg = await prepareRegistration();
  if (!reg) return;
  let sub: PushSubscription | null = null;
  try {
    sub = await reg.pushManager.getSubscription();
  } catch {
    sub = null;
  }
  if (!sub) {
    pushSubscribed.value = false;
    if (readPermission() !== 'granted' || local.get(USER_OFF_KEY) === '1') return;
    try {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
    } catch {
      // iOS may want a tap for this: show the card again.
      pushNeedsEnable.value = true;
      return;
    }
  }
  pushSubscribed.value = true;
  pushEndpoint.value = sub.endpoint;
  if (sub.endpoint !== local.get(ENDPOINT_KEY)) {
    try { await postSubscription(sub); } catch { /* retried next launch */ }
  }
}

/** Sends "Test notification" to every device this person has turned notifications on. */
export async function sendTestPush(): Promise<string> {
  try {
    const r = await call('testPush', {});
    if (r.sent === 0 && r.failed === 0) return 'No devices have notifications turned on yet.';
    if (r.failed > 0 && r.sent === 0) return 'The test notification couldn’t be sent.';
    return r.sent === 1 ? 'Sent to 1 device.' : `Sent to ${r.sent} devices.`;
  } catch (e) {
    return describeError(e);
  }
}

// ---------------------------------------------------------------- preferences

export const NOTIFICATION_EVENTS: { key: NotificationEvent; label: string; detail: string }[] = [
  { key: 'serviceDue', label: 'Service coming due', detail: 'Two weeks before, on your vehicles' },
  { key: 'serviceOverdue', label: 'Service overdue', detail: 'The day it becomes overdue' },
  { key: 'dealerService', label: 'Dealer’s next service', detail: 'Two weeks or 500 miles before' },
  { key: 'scanFiled', label: 'Receipt filed', detail: 'When a receipt you scanned is filed' },
  { key: 'scanNeedsAttention', label: 'Receipt needs another look', detail: 'When a scan needs attention' },
  { key: 'newRecall', label: 'New recall', detail: 'When a recall may apply to your vehicle' },
  { key: 'registration', label: 'Registration renewal', detail: 'Before the registration expires' },
  { key: 'warrantyEnding', label: 'Warranty ending', detail: 'About a month before' },
  { key: 'odometerNudge', label: 'Odometer reminders', detail: 'After 60 days without a reading' },
];

/** Missing keys mean "on". */
export function prefOn(prefs: NotificationPrefs | undefined, key: NotificationEvent): boolean {
  return prefs?.[key] !== false;
}

/** Saves one switch, shown immediately and put back if the save fails. Resolves to an error message or null. */
export async function setPref(key: NotificationEvent, on: boolean): Promise<string | null> {
  const b = bootstrap.value;
  if (!b) return 'Not signed in.';
  const before = b.user.prefs ?? {};
  const next: NotificationPrefs = { ...before, [key]: on };
  bootstrap.value = { ...b, user: { ...b.user, prefs: next } };
  try {
    const r = await call('savePrefs', { prefs: next });
    const cur = bootstrap.value;
    if (cur && r.prefs) bootstrap.value = { ...cur, user: { ...cur.user, prefs: r.prefs } };
    return null;
  } catch (e) {
    const cur = bootstrap.value;
    if (cur) bootstrap.value = { ...cur, user: { ...cur.user, prefs: { ...cur.user.prefs, [key]: prefOn(before, key) } } };
    return describeError(e);
  }
}

// ---------------------------------------------------------------- start-up

let started = false;

/** Called once after sign-in. */
export function startPush(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  void syncPush();
  document.addEventListener('visibilitychange', () => {
    // Permission can change in iPhone Settings while the app is in the background.
    if (document.visibilityState === 'visible') pushPermission.value = readPermission();
  });
  // Badge = Overdue items on my vehicles, after every refresh.
  effect(() => {
    const b = bootstrap.value;
    if (!standalone.value) return;
    void setBadge(b ? overdueCount(b.vehicles) : 0); // signed out → clear
  });
}
