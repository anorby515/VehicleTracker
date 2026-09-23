import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setTransport } from '../api/client';
import { clearAll, db } from '../lib/db';
import { todayYmd } from '../lib/format';
import {
  dismissOdometerNotice, flushOdometer, hasPendingOdometer, odometerNotice, pendingOdometerCount, submitOdometer,
} from './odometer';

type Body = Record<string, unknown>;
let sent: Body[] = [];
let reply: (body: Body) => unknown;

beforeEach(async () => {
  sent = [];
  await clearAll();
  dismissOdometerNotice();
  setTransport(async body => {
    sent.push(body);
    return reply(body);
  });
});

afterEach(() => {
  reply = () => ({ ok: true });
});

const offline = () => { throw new TypeError('Failed to fetch'); };
const saved = (b: Body) => ({ ok: true, reading: { readingId: b.clientId }, latestOdometer: b.mileage, latestOdometerDate: b.date });

describe('submitOdometer', () => {
  it('saves straight away with a client id and today’s date', async () => {
    reply = saved;
    const r = await submitOdometer({ vehicle: '2023 Toyota 4Runner', mileage: 38000.4, note: ' after trip ' });
    expect(r).toEqual({ kind: 'saved' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ action: 'addOdometer', vehicle: '2023 Toyota 4Runner', mileage: 38000, date: todayYmd(), note: 'after trip' });
    expect(String(sent[0].clientId)).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent[0]).not.toHaveProperty('confirmHigh');
    expect(pendingOdometerCount.value).toBe(0);
  });

  it('returns below_latest with the latest reading', async () => {
    reply = () => ({ ok: false, status: 409, error: 'below_latest', message: 'Lower', detail: { mileage: 40000, date: '2026-09-01' } });
    expect(await submitOdometer({ vehicle: 'V', mileage: 39000 })).toEqual({ kind: 'below_latest', mileage: 40000, date: '2026-09-01' });
  });

  it('returns confirm_high with the estimate, and passes confirmHigh when asked', async () => {
    reply = () => ({ ok: false, status: 409, error: 'confirm_high', message: 'High', detail: { estimate: 30000 } });
    expect(await submitOdometer({ vehicle: 'V', mileage: 99000 })).toEqual({ kind: 'confirm_high', estimate: 30000 });
    reply = saved;
    expect(await submitOdometer({ vehicle: 'V', mileage: 99000, confirmHigh: true })).toEqual({ kind: 'saved' });
    expect(sent[1].confirmHigh).toBe(true);
  });

  it('returns other API errors as messages', async () => {
    reply = () => ({ ok: false, status: 400, error: 'bad_request', message: 'Unknown vehicle.' });
    expect(await submitOdometer({ vehicle: 'V', mileage: 10 })).toEqual({ kind: 'error', message: 'Unknown vehicle.' });
  });

  it('rejects nonsense locally without calling the API', async () => {
    expect((await submitOdometer({ vehicle: 'V', mileage: Number.NaN })).kind).toBe('error');
    expect((await submitOdometer({ vehicle: 'V', mileage: 0 })).kind).toBe('error');
    expect(sent).toHaveLength(0);
  });
});

describe('offline queue', () => {
  it('queues when offline, then sends the same reading (same clientId) when back online', async () => {
    reply = offline;
    expect(await submitOdometer({ vehicle: 'V', mileage: 1234 })).toEqual({ kind: 'queued' });
    expect(pendingOdometerCount.value).toBe(1);
    expect(await hasPendingOdometer()).toBe(true);
    const clientId = sent[0].clientId;

    reply = saved;
    expect(await flushOdometer()).toBe(1);
    expect(sent[1]).toMatchObject({ action: 'addOdometer', vehicle: 'V', mileage: 1234, clientId });
    expect(pendingOdometerCount.value).toBe(0);
    expect(await hasPendingOdometer()).toBe(false);
  });

  it('keeps the queue in order and stops at the first connection problem', async () => {
    reply = offline;
    await submitOdometer({ vehicle: 'A', mileage: 100 });
    await new Promise(r => setTimeout(r, 2));
    await submitOdometer({ vehicle: 'B', mileage: 200 });
    expect(pendingOdometerCount.value).toBe(2);
    sent = [];
    expect(await flushOdometer()).toBe(0);
    expect(sent.map(b => b.vehicle)).toEqual(['A']);
    const stored = (await (await db()).getAll('odometer')).find(x => x.vehicle === 'A');
    expect(stored?.attempts).toBe(2);
    expect(pendingOdometerCount.value).toBe(2);
  });

  it('drops a queued reading the API refuses and remembers a message to show once', async () => {
    reply = offline;
    await submitOdometer({ vehicle: 'V', mileage: 500 });
    reply = () => ({ ok: false, status: 409, error: 'below_latest', message: 'Lower', detail: { mileage: 900, date: '2026-09-01' } });
    expect(await flushOdometer()).toBe(0);
    expect(pendingOdometerCount.value).toBe(0);
    expect(odometerNotice.value).toContain('500 mi');
    expect(odometerNotice.value).toContain('900 mi on Sep 1, 2026');
    expect(localStorage.getItem('vehicles.odometerNotice')).toBe(odometerNotice.value);
    dismissOdometerNotice();
    expect(odometerNotice.value).toBeNull();
    expect(localStorage.getItem('vehicles.odometerNotice')).toBeNull();
  });

  it('keeps a reading on a server error and retries later', async () => {
    reply = offline;
    await submitOdometer({ vehicle: 'V', mileage: 700 });
    reply = () => ({ ok: false, status: 500, error: 'server_error', message: 'Oops' });
    expect(await flushOdometer()).toBe(0);
    expect(pendingOdometerCount.value).toBe(1);
    reply = saved;
    expect(await flushOdometer()).toBe(1);
    expect(pendingOdometerCount.value).toBe(0);
  });

  it('a second flush while one is running shares it', async () => {
    reply = offline;
    await submitOdometer({ vehicle: 'V', mileage: 800 });
    reply = saved;
    sent = [];
    const [a, b] = await Promise.all([flushOdometer(), flushOdometer()]);
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(sent).toHaveLength(1);
  });
});
