/**
 * Odometer readings with an offline queue (spec 8.4, 10.2).
 *
 * submitOdometer() sends the reading straight away. With no connection it is
 * kept in IndexedDB (lib/db.ts › odometer) and sent automatically when the
 * phone is back online, when the app comes to the foreground, and at start-up.
 * The API is idempotent on clientId, so a resend after a lost reply never
 * adds a second row.
 *
 * A queued reading the API later refuses (lower than the latest reading, or
 * much higher than the estimate) is dropped, and a one-time message explains
 * why (odometerNotice).
 */

import { computed, effect, signal } from '@preact/signals';
import { ApiFailure, NetworkError, call } from '../api/client';
import { db, local, type QueuedOdometer } from '../lib/db';
import { formatDate, formatMiles, todayYmd } from '../lib/format';
import { refresh, session, vehicles } from './store';

export type OdometerOutcome =
  | { kind: 'saved' }
  | { kind: 'queued' }
  | { kind: 'below_latest'; mileage: number; date: string | null }
  | { kind: 'confirm_high'; estimate: number }
  | { kind: 'error'; message: string };

export interface OdometerInput {
  vehicle: string;
  mileage: number;
  note?: string;
  confirmHigh?: boolean;
}

/** Readings waiting on this phone, oldest first. */
export const pendingOdometer = signal<QueuedOdometer[]>([]);
/** "1 odometer reading waiting to send". */
export const pendingOdometerCount = computed(() => pendingOdometer.value.length);

// Sign-out wipes IndexedDB (store.resetDevice); forget the in-memory copy too.
effect(() => {
  if (!session.value) pendingOdometer.value = [];
});

const NOTICE_KEY = 'vehicles.odometerNotice';
/** A message about a queued reading that couldn't be saved; shown once, then dismissed. */
export const odometerNotice = signal<string | null>(local.get(NOTICE_KEY));

export function dismissOdometerNotice(): void {
  odometerNotice.value = null;
  local.remove(NOTICE_KEY);
}

function setNotice(text: string): void {
  const prev = odometerNotice.value;
  const next = prev ? `${prev}\n${text}` : text;
  odometerNotice.value = next;
  local.set(NOTICE_KEY, next);
}

function newClientId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `odo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

async function send(item: QueuedOdometer): Promise<void> {
  await call('addOdometer', {
    vehicle: item.vehicle,
    mileage: item.mileage,
    date: item.date,
    clientId: item.clientId,
    ...(item.note ? { note: item.note } : {}),
    ...(item.confirmHigh ? { confirmHigh: true } : {}),
  }, { timeoutMs: 30000 });
}

/** Reads the queue from IndexedDB into pendingOdometer. */
export async function loadPendingOdometer(): Promise<QueuedOdometer[]> {
  try {
    const all = await (await db()).getAll('odometer');
    all.sort((a, b) => a.createdAt - b.createdAt);
    pendingOdometer.value = all;
    return all;
  } catch {
    return pendingOdometer.value;
  }
}

/** True when a reading is still waiting on this phone (sign-out warns first). */
export async function hasPendingOdometer(): Promise<boolean> {
  return (await loadPendingOdometer()).length > 0;
}

/**
 * Saves a reading. Resolves (never rejects) with what happened:
 * - saved: on the Sheet; the bootstrap is refreshed in the background
 * - queued: no connection; it will be sent automatically
 * - below_latest / confirm_high: the API's validation (spec 8.4); nothing saved
 * - error: anything else, with a message safe to show
 */
export async function submitOdometer(input: OdometerInput): Promise<OdometerOutcome> {
  const mileage = Math.round(Number(input.mileage));
  if (!input.vehicle || !Number.isFinite(mileage) || mileage < 1 || mileage > 999999) {
    return { kind: 'error', message: 'Enter the mileage as a whole number.' };
  }
  const item: QueuedOdometer = {
    clientId: newClientId(),
    vehicle: input.vehicle,
    mileage,
    date: todayYmd(),
    note: input.note?.trim() || null,
    confirmHigh: !!input.confirmHigh,
    createdAt: Date.now(),
    attempts: 0,
    lastError: null,
  };
  try {
    await send(item);
    void refresh();
    return { kind: 'saved' };
  } catch (e) {
    if (e instanceof NetworkError) {
      try {
        await (await db()).put('odometer', { ...item, attempts: 1, lastError: e.message });
      } catch {
        return { kind: 'error', message: 'No connection, and this phone couldn’t save the reading for later. Try again when you’re online.' };
      }
      await loadPendingOdometer();
      return { kind: 'queued' };
    }
    if (e instanceof ApiFailure) {
      if (e.code === 'below_latest') {
        const d = e.detail ?? {};
        return { kind: 'below_latest', mileage: Number(d.mileage) || 0, date: typeof d.date === 'string' ? d.date : null };
      }
      if (e.code === 'confirm_high') {
        return { kind: 'confirm_high', estimate: Number(e.detail?.estimate) || 0 };
      }
      return { kind: 'error', message: e.message || 'That reading couldn’t be saved.' };
    }
    return { kind: 'error', message: e instanceof Error ? e.message : 'That reading couldn’t be saved.' };
  }
}

function shortName(vehicle: string): string {
  return vehicles.value.find(v => v.name === vehicle)?.shortName ?? vehicle;
}

let flushing: Promise<number> | null = null;

/**
 * Sends every queued reading, oldest first. Stops at the first connection
 * problem (the rest wait for the next try). Resolves with how many were saved.
 */
export function flushOdometer(): Promise<number> {
  if (!flushing) {
    flushing = doFlush().finally(() => { flushing = null; });
  }
  return flushing;
}

async function doFlush(): Promise<number> {
  const queue = await loadPendingOdometer();
  if (!queue.length) return 0;
  let saved = 0;
  for (const item of queue) {
    try {
      await send(item);
      await remove(item.clientId);
      saved++;
    } catch (e) {
      if (e instanceof NetworkError) {
        await update({ ...item, attempts: item.attempts + 1, lastError: e.message });
        break;
      }
      if (e instanceof ApiFailure) {
        const name = shortName(item.vehicle);
        if (e.code === 'below_latest') {
          const d = e.detail ?? {};
          const latest = Number(d.mileage);
          const when = typeof d.date === 'string' ? ` on ${formatDate(d.date)}` : '';
          setNotice(
            `Your odometer reading of ${formatMiles(item.mileage)} for the ${name} wasn’t saved: ` +
            `it’s lower than the last reading${Number.isFinite(latest) && latest ? ` (${formatMiles(latest)}${when})` : ''}.`,
          );
          await remove(item.clientId);
          continue;
        }
        if (e.code === 'confirm_high') {
          setNotice(
            `Your odometer reading of ${formatMiles(item.mileage)} for the ${name} wasn’t saved: ` +
            `it’s much higher than expected. If it’s right, enter it again.`,
          );
          await remove(item.clientId);
          continue;
        }
        if (e.status === 400 || e.status === 404 || e.status === 403) {
          setNotice(`Your odometer reading of ${formatMiles(item.mileage)} for the ${name} wasn’t saved: ${e.message}`);
          await remove(item.clientId);
          continue;
        }
        // 401 (signed out), 429, 5xx: keep it and try again later.
        await update({ ...item, attempts: item.attempts + 1, lastError: e.message });
        break;
      }
      await update({ ...item, attempts: item.attempts + 1, lastError: String(e) });
      break;
    }
  }
  await loadPendingOdometer();
  if (saved > 0) void refresh();
  return saved;
}

async function remove(clientId: string): Promise<void> {
  try { await (await db()).delete('odometer', clientId); } catch { /* ignore */ }
}

async function update(item: QueuedOdometer): Promise<void> {
  try { await (await db()).put('odometer', item); } catch { /* ignore */ }
}

let started = false;

/** Called once after sign-in: sends anything queued now, when back online, and on return to the app. */
export function startOdometerQueue(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  window.addEventListener('online', () => { void flushOdometer(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void flushOdometer();
  });
  void flushOdometer();
}
