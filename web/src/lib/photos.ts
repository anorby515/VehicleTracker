/**
 * Vehicle photos (spec 8.12). The App API serves each Vehicles › Photo File ID
 * resized (about 1,200 px wide); the phone keeps a copy in IndexedDB
 * ('photos' store, lib/db.ts) so card headers work offline and don't
 * re-download on every launch. A new photo gets a new Drive file ID, so the
 * cache never needs invalidating: entries for IDs no longer in use are pruned.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import { base64ToBlob, call } from '../api/client';
import { db, type CachedPhoto } from './db';

/** In-flight and finished loads in this tab, so five cards don't fetch the same photo twice. */
const inflight = new Map<string, Promise<Blob>>();

async function readCached(fileId: string): Promise<CachedPhoto | undefined> {
  try {
    return await (await db()).get('photos', fileId);
  } catch {
    return undefined; // storage unavailable (private mode): fall through to the network
  }
}

async function writeCached(photo: CachedPhoto): Promise<void> {
  try {
    await (await db()).put('photos', photo);
  } catch {
    /* storage unavailable: the photo still shows this session */
  }
}

/**
 * The photo's bytes: the IndexedDB copy when there is one, otherwise
 * `getFile {purpose: 'photo'}` (then cached). Rejects when offline and not cached.
 */
export function loadPhotoBlob(fileId: string): Promise<Blob> {
  const existing = inflight.get(fileId);
  if (existing) return existing;
  const p = (async () => {
    const cached = await readCached(fileId);
    if (cached?.blob) return cached.blob;
    const res = await call('getFile', { fileId, purpose: 'photo' });
    const mimeType = res.mimeType || 'image/jpeg';
    const blob = base64ToBlob(res.data, mimeType);
    await writeCached({ fileId, mimeType, blob, savedAt: Date.now() });
    return blob;
  })();
  inflight.set(fileId, p);
  // A failure (offline) must not stick: the next card mount tries again.
  p.catch(() => inflight.delete(fileId));
  return p;
}

/** Deletes cached photos whose file IDs are no longer used by any vehicle. */
export async function prunePhotos(keep: Iterable<string>): Promise<number> {
  const wanted = new Set(keep);
  try {
    const d = await db();
    const keys = await d.getAllKeys('photos');
    let removed = 0;
    for (const k of keys) {
      if (!wanted.has(k)) {
        await d.delete('photos', k);
        inflight.delete(k);
        removed++;
      }
    }
    return removed;
  } catch {
    return 0;
  }
}

/** Test hook: forget in-memory loads (the IndexedDB cache is untouched). */
export function resetPhotoMemo(): void {
  inflight.clear();
}

export type PhotoState = 'none' | 'loading' | 'ready' | 'error';

/**
 * Object URL for a vehicle photo, or null while loading / when there is none.
 * The URL is revoked when the component unmounts or the file ID changes.
 *
 * A failed load (a dropped request, the API busy) is tried again whenever
 * `retryKey` changes, e.g. on each data refresh, so the photo doesn't stay
 * missing until the app is closed. Loaded photos are left alone.
 */
export function usePhoto(fileId: string | null | undefined, retryKey?: unknown): { url: string | null; state: PhotoState } {
  const [result, setResult] = useState<{ url: string | null; state: PhotoState }>(
    fileId ? { url: null, state: 'loading' } : { url: null, state: 'none' },
  );
  const [attempt, setAttempt] = useState(0);
  const failed = useRef(false);
  failed.current = result.state === 'error';
  const seenKey = useRef(retryKey);

  useEffect(() => {
    if (Object.is(retryKey, seenKey.current)) return;
    seenKey.current = retryKey;
    if (failed.current) setAttempt(n => n + 1);
  }, [retryKey]);

  useEffect(() => {
    if (!fileId) {
      setResult({ url: null, state: 'none' });
      return;
    }
    let url: string | null = null;
    let cancelled = false;
    setResult({ url: null, state: 'loading' });
    loadPhotoBlob(fileId).then(
      blob => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setResult({ url, state: 'ready' });
      },
      () => {
        if (!cancelled) setResult({ url: null, state: 'error' });
      },
    );
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [fileId, attempt]);

  return result;
}
