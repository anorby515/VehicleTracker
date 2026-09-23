/**
 * On-device storage (IndexedDB via idb). Home-screen apps keep IndexedDB
 * across launches; everything here is also cleared on sign-out.
 *
 * Stores
 * - kv:       small values (last bootstrap + timestamp, UI flags)
 * - uploads:  finished PDFs waiting to upload (never lose a scan)
 * - odometer: readings entered offline, sent when back online
 * - docs:     last viewed receipts (LRU, max DOC_CACHE_MAX)
 * - photos:   vehicle photos for offline headers
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { ScanKind } from '../api/types';

export const DOC_CACHE_MAX = 20;

export interface QueuedUpload {
  scanId: string;
  kind: ScanKind;
  vehicleHint: string;
  pdf: Blob;
  pages: number;
  capturedAt: string;
  createdAt: number;
  attempts: number;
  lastError: string | null;
  /** Set while an upload is in flight in this tab (not persisted meaningfully). */
  state: 'queued' | 'uploading' | 'failed';
}

export interface QueuedOdometer {
  clientId: string;
  vehicle: string;
  mileage: number;
  date: string;
  note: string | null;
  confirmHigh: boolean;
  createdAt: number;
  attempts: number;
  lastError: string | null;
}

export interface CachedDoc {
  fileId: string;
  name: string;
  mimeType: string;
  blob: Blob;
  viewedAt: number;
}

export interface CachedPhoto {
  fileId: string;
  mimeType: string;
  blob: Blob;
  savedAt: number;
}

interface AppDB extends DBSchema {
  kv: { key: string; value: unknown };
  uploads: { key: string; value: QueuedUpload };
  odometer: { key: string; value: QueuedOdometer };
  docs: { key: string; value: CachedDoc; indexes: { viewedAt: number } };
  photos: { key: string; value: CachedPhoto };
}

let dbp: Promise<IDBPDatabase<AppDB>> | null = null;

export function db(): Promise<IDBPDatabase<AppDB>> {
  if (!dbp) {
    dbp = openDB<AppDB>('vehicles-app', 1, {
      upgrade(d) {
        d.createObjectStore('kv');
        d.createObjectStore('uploads', { keyPath: 'scanId' });
        d.createObjectStore('odometer', { keyPath: 'clientId' });
        const docs = d.createObjectStore('docs', { keyPath: 'fileId' });
        docs.createIndex('viewedAt', 'viewedAt');
        d.createObjectStore('photos', { keyPath: 'fileId' });
      },
    });
  }
  return dbp;
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  try {
    return (await (await db()).get('kv', key)) as T | undefined;
  } catch {
    return undefined;
  }
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  try {
    await (await db()).put('kv', value, key);
  } catch {
    /* storage unavailable (private mode): the app still works online */
  }
}

/** Saves a viewed document and trims the cache to the newest DOC_CACHE_MAX. */
export async function cacheDoc(doc: CachedDoc): Promise<void> {
  try {
    const d = await db();
    await d.put('docs', doc);
    const keys = await d.getAllKeysFromIndex('docs', 'viewedAt');
    const excess = keys.length - DOC_CACHE_MAX;
    for (let i = 0; i < excess; i++) await d.delete('docs', keys[i]);
  } catch {
    /* ignore */
  }
}

export async function getCachedDoc(fileId: string): Promise<CachedDoc | undefined> {
  try {
    const d = await db();
    const doc = await d.get('docs', fileId);
    if (doc) await d.put('docs', { ...doc, viewedAt: Date.now() });
    return doc;
  } catch {
    return undefined;
  }
}

/** Deletes everything on the device (sign-out). */
export async function clearAll(): Promise<void> {
  try {
    const d = await db();
    await Promise.all((['kv', 'uploads', 'odometer', 'docs', 'photos'] as const).map(s => d.clear(s)));
  } catch {
    /* ignore */
  }
}

/** localStorage helpers that never throw (private mode, disabled storage). */
export const local = {
  get(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key: string, value: string): void {
    try { localStorage.setItem(key, value); } catch { /* ignore */ }
  },
  remove(key: string): void {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  },
};
