import { Blob as NodeBlob } from 'node:buffer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTransport } from '../api/client';
import type { Scan } from '../api/types';
import { clearAll, db } from '../lib/db';
import {
  BACKOFF_MS, deleteUpload, enqueueUpload, flushUploads, hasPendingUploads, myScans, pendingUploadCount,
  resetUploadQueue, sessionScans, uploadItems, uploadStatus,
} from './queue';

// jsdom's Blob can't be structured-cloned into (fake) IndexedDB; a browser's can.
beforeAll(() => { vi.stubGlobal('Blob', NodeBlob); });
afterAll(() => { vi.unstubAllGlobals(); });

type Body = Record<string, unknown>;

/**
 * A small fake of the App API's upload endpoints (docs/API.md › Uploads),
 * with switches to simulate failures.
 */
class FakeServer {
  calls: Body[] = [];
  chunkSize = 4;
  offline = false;
  /** Called before each request; may throw (offline) or return a reply to short-circuit. */
  before: ((b: Body) => unknown) | null = null;
  /** Bytes per scanId, and the scans the server has finished. */
  sessions = new Map<string, { scanId: string; size: number; received: number; bytes: number[]; pages: number; kind: string; vehicleHint: string }>();
  done = new Map<string, Scan>();
  nextId = 1;
  /** Received-offset override for the next chunk reply (simulates a lost response). */
  skewNext: number | null = null;

  handle = async (b: Body): Promise<unknown> => {
    this.calls.push(b);
    if (this.offline) throw new TypeError('Failed to fetch');
    if (this.before) {
      const r = this.before(b);
      if (r !== undefined) return r;
    }
    if (b.action === 'uploadStart') {
      const scanId = String(b.scanId);
      const scan = this.done.get(scanId);
      if (scan) return { ok: true, done: true, scan };
      if (Number(b.size) > 25 * 1024 * 1024) return { ok: false, status: 413, error: 'too_large', message: 'Too large' };
      const uploadId = `up-${this.nextId++}`;
      this.sessions.set(uploadId, {
        scanId, size: Number(b.size), received: 0, bytes: [], pages: Number(b.pages), kind: String(b.kind), vehicleHint: String(b.vehicleHint),
      });
      return { ok: true, uploadId, chunkSize: this.chunkSize };
    }
    if (b.action === 'uploadChunk') {
      const up = this.sessions.get(String(b.uploadId));
      if (!up) return { ok: false, status: 404, error: 'not_found', message: 'Upload expired' };
      if (Number(b.offset) !== up.received) return { ok: true, received: up.received, done: false };
      const bytes = [...Buffer.from(String(b.data), 'base64')];
      up.bytes.push(...bytes);
      up.received += bytes.length;
      if (up.received < up.size) {
        if (this.skewNext !== null) { const r = this.skewNext; this.skewNext = null; return { ok: true, received: r, done: false }; }
        return { ok: true, received: up.received, done: false };
      }
      const scan: Scan = {
        scanId: up.scanId, kind: up.kind as Scan['kind'], vehicleHint: up.vehicleHint, fileId: `file-${up.scanId}`,
        fileName: `App scan - ${up.vehicleHint}.pdf`, pages: up.pages, uploadedAt: '2026-09-22T12:00:00-05:00',
        status: 'Waiting', statusLabel: 'Waiting to be filed', statusDetail: null, visitId: null, filedVehicle: null, lastChecked: null,
      };
      this.done.set(up.scanId, scan);
      this.sessions.delete(String(b.uploadId));
      return { ok: true, received: up.received, done: true, scan };
    }
    if (b.action === 'bootstrap') return { ok: false, status: 401, error: 'not_signed_in', message: 'no' };
    return { ok: false, status: 400, error: 'bad_request', message: 'unknown' };
  };

  actions(): string[] {
    return this.calls.map(c => String(c.action));
  }

  bytesFor(scanId: string): string {
    const s = [...this.sessions.values()].find(x => x.scanId === scanId);
    return s ? Buffer.from(s.bytes).toString('latin1') : '';
  }
}

let server: FakeServer;

const PDF_TEXT = '%PDF-1.4 fake pdf bytes for the queue test\n%%EOF';
const pdf = (text = PDF_TEXT) => new Blob([text], { type: 'application/pdf' });

async function stored(): Promise<string[]> {
  return (await (await db()).getAllKeys('uploads')).map(String);
}

beforeEach(async () => {
  resetUploadQueue();
  await clearAll();
  server = new FakeServer();
  setTransport(server.handle);
});

describe('enqueueUpload', () => {
  it('saves the PDF on the phone before any network call', async () => {
    server.offline = true;
    let storedAtFirstCall: string[] | null = null;
    server.handle = (orig => async (b: Body) => {
      if (storedAtFirstCall === null) storedAtFirstCall = await stored();
      return orig(b);
    })(server.handle);
    setTransport(server.handle);

    const scanId = await enqueueUpload({ kind: 'Receipt', vehicleHint: '2020 Test Car', pdf: pdf(), pages: 2 });
    expect(scanId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await stored()).toEqual([scanId]);
    await flushUploads();
    expect(storedAtFirstCall).toEqual([scanId]);

    const row = await (await db()).get('uploads', scanId);
    expect(row).toMatchObject({ kind: 'Receipt', vehicleHint: '2020 Test Car', pages: 2 });
    expect(await row!.pdf.text()).toBe(PDF_TEXT);
    expect(pendingUploadCount.value).toBe(1);
    expect(await hasPendingUploads()).toBe(true);
  });
});

describe('uploading', () => {
  it('sends uploadStart then chunks of the server’s chunk size, and cleans up when done', async () => {
    const scanId = await enqueueUpload({ kind: 'Upload', vehicleHint: '2020 Test Car', pdf: pdf(), pages: 1, capturedAt: '2026-09-22T10:00:00-05:00' });
    await flushUploads();

    const start = server.calls.find(c => c.action === 'uploadStart')!;
    expect(start).toMatchObject({ scanId, kind: 'Upload', vehicleHint: '2020 Test Car', size: PDF_TEXT.length, pages: 1, capturedAt: '2026-09-22T10:00:00-05:00' });
    const chunks = server.calls.filter(c => c.action === 'uploadChunk');
    expect(chunks).toHaveLength(Math.ceil(PDF_TEXT.length / server.chunkSize));
    expect(chunks.map(c => c.offset)).toEqual(chunks.map((_, i) => i * server.chunkSize));
    const joined = chunks.map(c => Buffer.from(String(c.data), 'base64').toString('latin1')).join('');
    expect(joined).toBe(PDF_TEXT);

    expect(await stored()).toEqual([]);
    expect(pendingUploadCount.value).toBe(0);
    expect(await hasPendingUploads()).toBe(false);
    expect(sessionScans.value.map(s => s.scanId)).toEqual([scanId]);
    expect(myScans.value[0].scanId).toBe(scanId);
    expect(uploadStatus(scanId).phase).toBe('done');
  });

  it('resends from the server’s received offset', async () => {
    server.chunkSize = 8;
    server.skewNext = 4; // the server says it only kept 4 bytes of the first 8
    const scanId = await enqueueUpload({ kind: 'Receipt', vehicleHint: 'Car', pdf: pdf(), pages: 1 });
    // Make the server consistent with what it claimed.
    const origHandle = server.handle;
    let fixed = false;
    setTransport(async b => {
      if (!fixed && b.action === 'uploadChunk' && Number(b.offset) === 4) {
        const up = [...server.sessions.values()][0];
        up.received = 4;
        up.bytes = up.bytes.slice(0, 4);
        fixed = true;
      }
      return origHandle(b);
    });
    await flushUploads();
    const offsets = server.calls.filter(c => c.action === 'uploadChunk').map(c => c.offset);
    expect(offsets.slice(0, 3)).toEqual([0, 4, 12]);
    expect(server.done.has(scanId)).toBe(true);
    expect(await stored()).toEqual([]);
  });

  it('uploads one at a time, oldest first', async () => {
    server.offline = true;
    const a = await enqueueUpload({ kind: 'Receipt', vehicleHint: 'Car', pdf: pdf('%PDF-a'), pages: 1 });
    const b = await enqueueUpload({ kind: 'Receipt', vehicleHint: 'Car', pdf: pdf('%PDF-b'), pages: 1 });
    await flushUploads();
    server.offline = false;
    server.calls = [];
    await flushUploads();
    const starts = server.calls.filter(c => c.action === 'uploadStart').map(c => c.scanId);
    expect(starts).toEqual([a, b]);
    expect(pendingUploadCount.value).toBe(0);
  });
});

describe('failures', () => {
  it('keeps the scan after a network error and retries it later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      server.offline = true;
      const scanId = await enqueueUpload({ kind: 'Receipt', vehicleHint: 'Car', pdf: pdf(), pages: 1 });
      await flushUploads();
      expect(uploadItems.value[0]).toMatchObject({ scanId, phase: 'retrying', error: 'No connection' });
      expect((await (await db()).get('uploads', scanId))!.attempts).toBe(1);
      expect(await stored()).toEqual([scanId]);

      server.offline = false;
      const before = server.calls.length;
      await vi.advanceTimersByTimeAsync(BACKOFF_MS[0] - 100);
      expect(server.calls.length).toBe(before);
      await vi.advanceTimersByTimeAsync(200);
    } finally {
      vi.useRealTimers();
    }
    await flushUploads();
    expect(pendingUploadCount.value).toBe(0);
    expect(await stored()).toEqual([]);
    expect(server.done.size).toBe(1);
  });

  it('continues the same server session after a dropped chunk', async () => {
    let drop = true;
    server.before = b => {
      if (b.action === 'uploadChunk' && Number(b.offset) === 8 && drop) { drop = false; throw new TypeError('Failed to fetch'); }
      return undefined;
    };
    const scanId = await enqueueUpload({ kind: 'Receipt', vehicleHint: 'Car', pdf: pdf(), pages: 1 });
    await flushUploads();
    expect(uploadItems.value[0].phase).toBe('retrying');
    expect(uploadItems.value[0].progress).toBeCloseTo(8 / PDF_TEXT.length);
    await flushUploads();
    expect(server.actions().filter(a => a === 'uploadStart')).toHaveLength(1);
    expect(server.done.get(scanId)).toBeTruthy();
  });

  it('starts again with the same scanId when the server session has expired (404)', async () => {
    let expire = true;
    server.before = b => {
      if (b.action === 'uploadChunk' && Number(b.offset) === 8 && expire) {
        expire = false;
        server.sessions.clear();
        return { ok: false, status: 404, error: 'not_found', message: 'Upload expired' };
      }
      return undefined;
    };
    const scanId = await enqueueUpload({ kind: 'Receipt', vehicleHint: 'Car', pdf: pdf(), pages: 1 });
    await flushUploads();
    const starts = server.calls.filter(c => c.action === 'uploadStart');
    expect(starts).toHaveLength(2);
    expect(starts.map(s => s.scanId)).toEqual([scanId, scanId]);
    // The second session got every byte from the start.
    const secondChunks = server.calls.slice(server.calls.indexOf(starts[1])).filter(c => c.action === 'uploadChunk');
    expect(secondChunks[0].offset).toBe(0);
    expect(server.done.has(scanId)).toBe(true);
    expect(pendingUploadCount.value).toBe(0);
  });

  it('marks 413 as a permanent failure, keeps the PDF, and lets the person delete it', async () => {
    server.before = b => (b.action === 'uploadStart' ? { ok: false, status: 413, error: 'too_large', message: 'Too large' } : undefined);
    const scanId = await enqueueUpload({ kind: 'Upload', vehicleHint: 'Car', pdf: pdf(), pages: 1 });
    await flushUploads();
    expect(uploadItems.value[0]).toMatchObject({ scanId, phase: 'failed' });
    expect(uploadItems.value[0].error).toMatch(/25 MB/);
    expect((await (await db()).get('uploads', scanId))!.state).toBe('failed');
    expect(pendingUploadCount.value).toBe(1);

    // Not retried by later runs.
    server.calls = [];
    await flushUploads();
    expect(server.calls).toHaveLength(0);

    await deleteUpload(scanId);
    expect(await stored()).toEqual([]);
    expect(pendingUploadCount.value).toBe(0);
  });

  it('pauses on 401 and keeps the scan', async () => {
    server.before = () => ({ ok: false, status: 401, error: 'not_signed_in', message: 'Please sign in again.' });
    const scanId = await enqueueUpload({ kind: 'Receipt', vehicleHint: 'Car', pdf: pdf(), pages: 1 });
    await flushUploads();
    expect(uploadItems.value[0]).toMatchObject({ scanId, phase: 'paused' });
    expect(await stored()).toEqual([scanId]);
    server.calls = [];
    await flushUploads();
    expect(server.calls).toHaveLength(0);
  });

  it('treats a repeat start as done (idempotent on scanId) without sending bytes again', async () => {
    const scanId = await enqueueUpload({ kind: 'Receipt', vehicleHint: 'Car', pdf: pdf(), pages: 1 });
    server.offline = true;
    await flushUploads();
    // The server finished it from an earlier try whose reply was lost.
    server.offline = false;
    server.done.set(scanId, {
      scanId, kind: 'Receipt', vehicleHint: 'Car', fileId: 'f', fileName: 'x.pdf', pages: 1, uploadedAt: null,
      status: 'Waiting', statusLabel: 'Waiting to be filed', statusDetail: null, visitId: null, filedVehicle: null, lastChecked: null,
    });
    server.calls = [];
    await flushUploads();
    expect(server.actions().filter(a => a !== 'bootstrap')).toEqual(['uploadStart']);
    expect(pendingUploadCount.value).toBe(0);
    expect(sessionScans.value[0].scanId).toBe(scanId);
  });
});
