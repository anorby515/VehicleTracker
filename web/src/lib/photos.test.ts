import { Blob as NodeBlob } from 'node:buffer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTransport } from '../api/client';
import { db } from './db';
import { loadPhotoBlob, prunePhotos, resetPhotoMemo } from './photos';

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let calls: Record<string, unknown>[] = [];
let offline = false;

// jsdom's Blob can't be structured-cloned into (fake) IndexedDB; a browser's
// can. Node's own Blob behaves like the browser's here.
beforeAll(() => { vi.stubGlobal('Blob', NodeBlob); });
afterAll(() => { vi.unstubAllGlobals(); });

beforeEach(async () => {
  calls = [];
  offline = false;
  resetPhotoMemo();
  const d = await db();
  await d.clear('photos');
  setTransport(async body => {
    calls.push(body);
    if (offline) throw new TypeError('Failed to fetch');
    return { ok: true, fileId: body.fileId, name: 'photo.png', mimeType: 'image/png', size: 70, data: PNG_B64 };
  });
});

afterEach(() => resetPhotoMemo());

describe('loadPhotoBlob', () => {
  it('fetches a photo once with purpose "photo" and caches it in IndexedDB', async () => {
    const blob = await loadPhotoBlob('photo-a');
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBeGreaterThan(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ action: 'getFile', fileId: 'photo-a', purpose: 'photo' });

    const stored = await (await db()).get('photos', 'photo-a');
    expect(stored?.fileId).toBe('photo-a');
    expect(stored?.mimeType).toBe('image/png');
  });

  it('serves the cached copy without calling the API (works offline)', async () => {
    await loadPhotoBlob('photo-b');
    resetPhotoMemo(); // a fresh app launch: only IndexedDB remains
    offline = true;
    const again = await loadPhotoBlob('photo-b');
    expect(again.type).toBe('image/png');
    expect(calls).toHaveLength(1);
  });

  it('shares one request between cards asking at the same time', async () => {
    const [a, b] = await Promise.all([loadPhotoBlob('photo-c'), loadPhotoBlob('photo-c')]);
    expect(a).toBe(b);
    expect(calls).toHaveLength(1);
  });

  it('rejects offline when nothing is cached, and retries later', async () => {
    offline = true;
    await expect(loadPhotoBlob('photo-d')).rejects.toThrow();
    offline = false;
    await expect(loadPhotoBlob('photo-d')).resolves.toBeTruthy();
    expect(calls).toHaveLength(2);
  });

  it('prunes photos no vehicle uses any more', async () => {
    await loadPhotoBlob('keep-me');
    await loadPhotoBlob('old-photo');
    expect(await prunePhotos(['keep-me'])).toBe(1);
    const keys = await (await db()).getAllKeys('photos');
    expect(keys).toEqual(['keep-me']);
  });
});
