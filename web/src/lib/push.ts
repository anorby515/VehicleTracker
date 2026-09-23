/**
 * Web Push helpers shared by the app (state/push.ts) and the service worker
 * (sw.ts). Pure functions only: no DOM, no signals.
 *
 * iOS rules this follows (see docs/API.md › Push):
 * - The VAPID public key goes to pushManager.subscribe as a Uint8Array.
 * - Every push must show a notification, even a malformed one, or iOS revokes
 *   the subscription, so parsePushPayload never throws and always returns a
 *   title and body.
 * - The API sends {title, body, url, tag}; the Worker wraps it as Declarative
 *   Web Push {web_push: 8030, notification: {title, body, navigate, tag, data}}.
 */

import type { Vehicle } from '../api/types';

/** IndexedDB kv key (lib/db.ts) where the service worker leaves a tapped notification's URL. */
export const PENDING_DEEPLINK_KEY = 'pendingDeepLink';

export interface PendingDeepLink {
  url: string;
  /** Epoch ms when the notification was tapped. */
  at: number;
}

/** Base64url (or base64) string → bytes. Throws on invalid input. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const clean = base64.trim();
  const padded = clean.padEnd(Math.ceil(clean.length / 4) * 4, '=').replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Bytes → base64url without padding. */
export function uint8ArrayToUrlBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A VAPID public key is an uncompressed P-256 point: 65 bytes starting with 0x04. */
export function vapidKeyBytes(key: string | null | undefined): Uint8Array<ArrayBuffer> | null {
  if (!key) return null;
  try {
    const bytes = urlBase64ToUint8Array(key);
    return bytes.length === 65 && bytes[0] === 4 ? bytes : null;
  } catch {
    return null;
  }
}

export interface ParsedPush {
  title: string;
  body: string;
  /** Absolute in-scope URL to open on tap. */
  url: string;
  tag?: string;
  /** Declarative Web Push app_badge, when present. */
  badge?: number;
}

const GENERIC_TITLE = 'Vehicles';
const GENERIC_BODY = 'Open the app for details';

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

/**
 * Only URLs inside the app's scope are opened. Anything else (another site,
 * javascript:, garbage) falls back to the app's start page.
 */
export function resolveNotificationUrl(raw: unknown, scope: string): string {
  if (typeof raw !== 'string' || !raw) return scope;
  try {
    const u = new URL(raw, scope);
    const s = new URL(scope);
    if (u.origin !== s.origin || !u.pathname.startsWith(s.pathname)) return scope;
    return u.href;
  } catch {
    return scope;
  }
}

/**
 * Parses a push message body. Accepts the Declarative Web Push shape and the
 * plain {title, body, url, tag} shape; anything else becomes a generic
 * "Vehicles / Open the app for details" notification. Never throws.
 */
export function parsePushPayload(data: string | null | undefined, scope: string): ParsedPush {
  const generic: ParsedPush = { title: GENERIC_TITLE, body: GENERIC_BODY, url: scope };
  if (!data) return generic;
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return generic;
  }
  if (!json || typeof json !== 'object') return generic;
  const top = json as Record<string, unknown>;
  const n = (top.notification && typeof top.notification === 'object' ? top.notification : top) as Record<string, unknown>;
  const data2 = (n.data && typeof n.data === 'object' ? n.data : {}) as Record<string, unknown>;
  const title = str(n.title);
  const body = str(n.body);
  if (!title && !body) return generic;
  const out: ParsedPush = {
    title: title ?? GENERIC_TITLE,
    body: body ?? '',
    url: resolveNotificationUrl(str(n.navigate) ?? str(data2.url) ?? str(n.url), scope),
  };
  const tag = str(n.tag);
  if (tag) out.tag = tag;
  const badge = top.app_badge;
  const badgeNum = typeof badge === 'number' ? badge : typeof badge === 'string' && /^\d+$/.test(badge) ? Number(badge) : NaN;
  if (Number.isFinite(badgeNum) && badgeNum >= 0) out.badge = Math.floor(badgeNum);
  return out;
}

/** Number of Overdue Upcoming items on the signed-in person's own vehicles (the app badge). */
export function overdueCount(vehicles: Vehicle[]): number {
  let n = 0;
  for (const v of vehicles) {
    if (!v.isMine) continue;
    for (const u of v.upcoming) if (u.status === 'Overdue') n++;
  }
  return n;
}

type BadgeNavigator = {
  setAppBadge?: (n?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

/** Sets or clears the home-screen badge. Silently does nothing where unsupported. */
export async function setBadge(count: number, nav: BadgeNavigator = (typeof navigator === 'undefined' ? {} : navigator) as BadgeNavigator): Promise<void> {
  try {
    if (count > 0) await nav.setAppBadge?.(count);
    else await nav.clearAppBadge?.();
  } catch {
    /* not installed, or badges turned off in Settings */
  }
}
