import { Blob as NodeBlob } from 'node:buffer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTransport } from '../api/client';
import { db } from './db';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { loadPhotoBlob, prunePhotos, resetPhotoMemo, usePhoto, type PhotoState } from './photos';

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

describe('usePhoto', () => {
  let states: PhotoState[] = [];
  function Probe(props: { fileId: string; retryKey: number }) {
    states.push(usePhoto(props.fileId, props.retryKey).state);
    return null;
  }
  const container = document.createElement('div');
  const show = (retryKey: number) => act(() => { render(h(Probe, { fileId: 'photo-e', retryKey }), container); });
  /** Lets the fetch, IndexedDB and state updates settle. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await act(() => new Promise<void>(r => setTimeout(r, 0)));
  }

  beforeAll(() => {
    URL.createObjectURL = () => 'blob:photo';
    URL.revokeObjectURL = () => {};
  });
  beforeEach(() => { states = []; });
  afterEach(() => { render(null, container); });

  it('tries a failed photo again when the retry key changes, and leaves a loaded one alone', async () => {
    offline = true;
    await show(1);
    await settle();
    expect(states.at(-1)).toBe('error');
    expect(calls).toHaveLength(1);

    // Same key (a re-render without a refresh): no retry.
    await show(1);
    await settle();
    expect(calls).toHaveLength(1);

    offline = false;
    await show(2); // e.g. a data refresh
    await settle();
    expect(states.at(-1)).toBe('ready');
    expect(calls).toHaveLength(2);

    await show(3);
    await settle();
    expect(states.at(-1)).toBe('ready');
    expect(calls).toHaveLength(2);
  });
});
