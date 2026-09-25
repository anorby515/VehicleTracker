import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTransport } from '../api/client';
import { offlineText } from '../components/Banners';
import { clearAll } from '../lib/db';
import { online, refresh, resetDevice, session } from './store';

let calls = 0;
let failing = true;

const BOOTSTRAP = { user: { email: 'robert@example.com', name: 'Robert' }, vehicles: [] };

/** Lets the transport, IndexedDB and signal updates settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>(r => setImmediate(r));
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await clearAll();
  calls = 0;
  failing = true;
  session.value = 'test-session';
  setTransport(async () => {
    calls++;
    if (failing) throw new TypeError('The network connection was lost.');
    return { ok: true, bootstrap: BOOTSTRAP };
  });
});

afterEach(async () => {
  await resetDevice();
  vi.useRealTimers();
});

describe('refresh', () => {
  it('retries on its own after the server can’t be reached, and stops once it gets through', async () => {
    expect(await refresh()).toBe(false);
    expect(online.value).toBe(false);
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(3000);
    await settle();
    expect(calls).toBe(2);

    failing = false;
    await vi.advanceTimersByTimeAsync(10000);
    await settle();
    expect(calls).toBe(3);
    expect(online.value).toBe(true);

    // Nothing else is scheduled.
    await vi.advanceTimersByTimeAsync(60000);
    await settle();
    expect(calls).toBe(3);
  });

  it('gives up after three retries until the next refresh someone asks for', async () => {
    await refresh();
    for (const ms of [3000, 10000, 30000, 60000, 120000]) {
      await vi.advanceTimersByTimeAsync(ms);
      await settle();
    }
    expect(calls).toBe(4);

    // Pull to refresh (or coming back to the app) starts over.
    await refresh();
    expect(calls).toBe(5);
    await vi.advanceTimersByTimeAsync(3000);
    await settle();
    expect(calls).toBe(6);
  });
});

describe('offlineText', () => {
  const at = Date.UTC(2026, 8, 24, 23, 18); // 6:18 PM in Chicago
  const now = Date.UTC(2026, 8, 25, 14, 5);

  it('says Offline when the phone has no connection', () => {
    expect(offlineText(at, now, false)).toBe('Offline: showing data from Sep 24, 6:18 PM');
  });

  it('says it couldn’t connect when the phone is online but the server wasn’t reached', () => {
    expect(offlineText(at, now, true)).toBe('Couldn’t connect: showing data from Sep 24, 6:18 PM');
  });
});
