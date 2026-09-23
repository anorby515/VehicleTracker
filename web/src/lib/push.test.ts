import { describe, expect, it, vi } from 'vitest';
import type { Vehicle } from '../api/types';
import {
  overdueCount, parsePushPayload, resolveNotificationUrl, setBadge, uint8ArrayToUrlBase64, urlBase64ToUint8Array, vapidKeyBytes,
} from './push';
import { deviceLabel } from './platform';

const SCOPE = 'https://example.github.io/VehicleTracker/';

// A syntactically valid (random) uncompressed P-256 public key, base64url, 87 chars.
const bytes = new Uint8Array(65);
bytes[0] = 4;
for (let i = 1; i < 65; i++) bytes[i] = (i * 37) % 256;
const KEY = uint8ArrayToUrlBase64(bytes);

describe('VAPID key conversion', () => {
  it('round-trips base64url without padding', () => {
    expect(KEY).toHaveLength(87);
    expect(KEY).not.toMatch(/[+/=]/);
    expect(Array.from(urlBase64ToUint8Array(KEY))).toEqual(Array.from(bytes));
  });

  it('accepts standard base64 with padding too', () => {
    expect(Array.from(urlBase64ToUint8Array('+/8='))).toEqual([251, 255]);
    expect(Array.from(urlBase64ToUint8Array('-_8'))).toEqual([251, 255]);
  });

  it('validates a 65-byte uncompressed point', () => {
    expect(vapidKeyBytes(KEY)?.length).toBe(65);
    expect(vapidKeyBytes('')).toBeNull();
    expect(vapidKeyBytes(undefined)).toBeNull();
    expect(vapidKeyBytes(uint8ArrayToUrlBase64(bytes.slice(0, 33)))).toBeNull();
    const wrongPrefix = bytes.slice();
    wrongPrefix[0] = 2;
    expect(vapidKeyBytes(uint8ArrayToUrlBase64(wrongPrefix))).toBeNull();
    expect(vapidKeyBytes('not base64 at all!!')).toBeNull();
  });
});

describe('parsePushPayload', () => {
  it('reads the Declarative Web Push shape', () => {
    const p = parsePushPayload(JSON.stringify({
      web_push: 8030,
      notification: { title: '4Runner', body: 'Tire rotation due in 2 weeks', navigate: `${SCOPE}#/v/2023%20Toyota%204Runner`, tag: 'due:x', data: { url: `${SCOPE}#/v/2023%20Toyota%204Runner` } },
      app_badge: 2,
    }), SCOPE);
    expect(p).toEqual({ title: '4Runner', body: 'Tire rotation due in 2 weeks', url: `${SCOPE}#/v/2023%20Toyota%204Runner`, tag: 'due:x', badge: 2 });
  });

  it('reads the plain {title, body, url, tag} shape', () => {
    expect(parsePushPayload(JSON.stringify({ title: 'Test notification', body: 'It works', url: `${SCOPE}#/settings`, tag: 't' }), SCOPE))
      .toEqual({ title: 'Test notification', body: 'It works', url: `${SCOPE}#/settings`, tag: 't' });
  });

  it('falls back to a generic notification for anything malformed', () => {
    const generic = { title: 'Vehicles', body: 'Open the app for details', url: SCOPE };
    expect(parsePushPayload(null, SCOPE)).toEqual(generic);
    expect(parsePushPayload('', SCOPE)).toEqual(generic);
    expect(parsePushPayload('not json', SCOPE)).toEqual(generic);
    expect(parsePushPayload('42', SCOPE)).toEqual(generic);
    expect(parsePushPayload('{}', SCOPE)).toEqual(generic);
    expect(parsePushPayload(JSON.stringify({ notification: { title: '' } }), SCOPE)).toEqual(generic);
  });

  it('never opens a URL outside the app', () => {
    expect(parsePushPayload(JSON.stringify({ title: 'x', body: 'y', url: 'https://evil.example.com/' }), SCOPE).url).toBe(SCOPE);
    expect(resolveNotificationUrl('javascript:alert(1)', SCOPE)).toBe(SCOPE);
    expect(resolveNotificationUrl('https://example.github.io/Other/', SCOPE)).toBe(SCOPE);
    expect(resolveNotificationUrl('#/scans/s1', SCOPE)).toBe(`${SCOPE}#/scans/s1`);
    expect(resolveNotificationUrl(undefined, SCOPE)).toBe(SCOPE);
  });
});

describe('badge', () => {
  it('counts Overdue items on my own vehicles only', () => {
    const v = (isMine: boolean, statuses: string[]) => ({ isMine, upcoming: statuses.map(status => ({ status })) }) as unknown as Vehicle;
    expect(overdueCount([v(true, ['Overdue', 'OK', 'Overdue']), v(false, ['Overdue']), v(true, ['Due soon'])])).toBe(2);
  });

  it('sets, clears, and swallows errors', async () => {
    const nav = { setAppBadge: vi.fn(async () => {}), clearAppBadge: vi.fn(async () => {}) };
    await setBadge(3, nav);
    expect(nav.setAppBadge).toHaveBeenCalledWith(3);
    await setBadge(0, nav);
    expect(nav.clearAppBadge).toHaveBeenCalled();
    await expect(setBadge(1, { setAppBadge: async () => { throw new Error('nope'); } })).resolves.toBeUndefined();
    await expect(setBadge(1, {})).resolves.toBeUndefined();
  });
});

describe('deviceLabel', () => {
  it('gives a short name, never the whole user agent', () => {
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15', 5)).toBe('iPhone');
    expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 5)).toBe('iPad');
    expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 0)).toBe('Mac');
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari', 5)).toBe('Android phone');
    expect(deviceLabel('something else', 0)).toBe('Browser');
  });
});
