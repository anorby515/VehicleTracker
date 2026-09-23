import { beforeEach, describe, expect, it } from 'vitest';
import { clearAll, kvGet, kvSet } from '../lib/db';
import { PENDING_DEEPLINK_KEY } from '../lib/push';
import { DEEPLINK_MAX_AGE_MS, deepLinkHash, takePendingDeepLink } from './deeplink';

const BASE = 'https://example.github.io/VehicleTracker/';

describe('deepLinkHash', () => {
  it('accepts in-app URLs and returns their hash route', () => {
    expect(deepLinkHash(`${BASE}#/v/2023%20Toyota%204Runner`, BASE)).toBe('#/v/2023%20Toyota%204Runner');
    expect(deepLinkHash(`${BASE}#/v/2016%20Jeep%20Wrangler/visit/jp-1`, BASE)).toBe('#/v/2016%20Jeep%20Wrangler/visit/jp-1');
    expect(deepLinkHash(`${BASE}index.html#/scans/abc`, BASE)).toBe('#/scans/abc');
    expect(deepLinkHash('https://example.github.io/VehicleTracker#/settings', BASE)).toBe('#/settings');
    expect(deepLinkHash('#/search?q=brakes%20jeep', BASE)).toBe('#/search?q=brakes%20jeep');
  });

  it('treats the bare app URL as home', () => {
    expect(deepLinkHash(BASE, BASE)).toBe('#/');
    expect(deepLinkHash(`${BASE}#`, BASE)).toBe('#/');
  });

  it('refuses other sites, other paths and non-routes', () => {
    expect(deepLinkHash('https://evil.example.com/VehicleTracker/#/settings', BASE)).toBeNull();
    expect(deepLinkHash('https://example.github.io/OtherRepo/#/settings', BASE)).toBeNull();
    expect(deepLinkHash('javascript:alert(1)', BASE)).toBeNull();
    expect(deepLinkHash(`${BASE}#javascript:alert(1)`, BASE)).toBeNull();
    // Raw markup never survives: URL parsing percent-encodes it, and a bare hash with it is refused.
    expect(deepLinkHash(`${BASE}#/v/x"><img>`, BASE)).toBe('#/v/x%22%3E%3Cimg%3E');
    expect(deepLinkHash('#/v/x"><img>', BASE)).toBeNull();
    expect(deepLinkHash('', BASE)).toBeNull();
    expect(deepLinkHash(null, BASE)).toBeNull();
    expect(deepLinkHash(42, BASE)).toBeNull();
  });

  it('never replays sign-in fragments', () => {
    expect(deepLinkHash(`${BASE}#state=abc&id_token=xyz`, BASE)).toBeNull();
    expect(deepLinkHash(`${BASE}#/x&id_token=xyz`, BASE)).toBeNull();
  });
});

describe('takePendingDeepLink', () => {
  beforeEach(async () => { await clearAll(); });

  it('returns the stored link once, then clears it', async () => {
    const now = Date.now();
    await kvSet(PENDING_DEEPLINK_KEY, { url: `${BASE}#/v/2023%20BMW%20X7`, at: now - 1000 });
    expect(await takePendingDeepLink(now, BASE)).toBe('#/v/2023%20BMW%20X7');
    expect(await kvGet(PENDING_DEEPLINK_KEY)).toBeUndefined();
    expect(await takePendingDeepLink(now, BASE)).toBeNull();
  });

  it('ignores (and clears) stale or foreign links', async () => {
    const now = Date.now();
    await kvSet(PENDING_DEEPLINK_KEY, { url: `${BASE}#/settings`, at: now - DEEPLINK_MAX_AGE_MS - 1 });
    expect(await takePendingDeepLink(now, BASE)).toBeNull();
    expect(await kvGet(PENDING_DEEPLINK_KEY)).toBeUndefined();

    await kvSet(PENDING_DEEPLINK_KEY, { url: 'https://evil.example.com/#/settings', at: now });
    expect(await takePendingDeepLink(now, BASE)).toBeNull();
    expect(await kvGet(PENDING_DEEPLINK_KEY)).toBeUndefined();
  });

  it('returns null when nothing is pending', async () => {
    expect(await takePendingDeepLink(Date.now(), BASE)).toBeNull();
  });
});
