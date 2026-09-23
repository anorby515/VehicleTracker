/**
 * The scan upload queue (spec 7.2, docs/API.md › Uploads). Never lose a scan:
 *
 * 1. enqueueUpload() writes the finished PDF to IndexedDB (lib/db.ts ›
 *    uploads) BEFORE any network call.
 * 2. One upload at a time: `uploadStart` (idempotent on scanId), then
 *    `uploadChunk` slices of the server's chunkSize, always resending from
 *    the server's `received` offset.
 * 3. Done → the PDF is deleted from the phone, the returned Scan is kept in
 *    `sessionScans` (merged into My scans until the bootstrap has it) and the
 *    bootstrap is refreshed.
 *
 * Failures:
 * - NetworkError (offline, timeout): retried on `online`, when the app comes
 *   back to the foreground, and on a 5 s / 15 s / 60 s / 5 min backoff.
 * - 404 not_found on a chunk (the server's upload session expired): start
 *   again with the SAME scanId (nothing was written yet, so that's safe).
 * - 413 too_large and other 4xx refusals: permanent. The PDF stays on the
 *   phone until the person deletes it from My scans.
 * - 401/403: paused until the person signs in again.
 * - 429/5xx and anything unexpected: retried like a network error.
 */

import { computed, effect, signal } from '@preact/signals';
import { ApiFailure, NetworkError, blobToBase64, call } from '../api/client';
import type { Scan, ScanKind } from '../api/types';
import { db, type QueuedUpload } from '../lib/db';
import { bootstrap, refresh, session } from '../state/store';

/** What My scans and the upload screen show for an item still on the phone. */
export type UploadPhase =
  | 'queued'     // waiting its turn (or for a connection)
  | 'uploading'  // bytes are moving; see `progress`
  | 'retrying'   // a try failed; will retry automatically
  | 'paused'     // signed out / not allowed; resumes after sign-in
  | 'failed';    // permanent: the server refused it (e.g. over 25 MB)

export interface UploadItem {
  scanId: string;
  kind: ScanKind;
  vehicleHint: string;
  pages: number;
  size: number;
  capturedAt: string;
  createdAt: number;
  phase: UploadPhase;
  /** 0..1 of the bytes the server has accepted. */
  progress: number;
  /** Friendly reason for the last failure. */
  error: string | null;
  /** True when the phone couldn't save the PDF (private mode): it's only in memory. */
  volatile: boolean;
}

export interface EnqueueInput {
  kind: ScanKind;
  vehicleHint: string;
  pdf: Blob;
  pages: number;
  /** When the pages were captured (ISO). Defaults to now. */
  capturedAt?: string;
}

/** Retry delays after consecutive failures. */
export const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000];
/** Restarts with the same scanId per try before giving up until the next retry. */
const MAX_RESTARTS = 3;

/** Items on this phone, oldest first. */
export const uploadItems = signal<UploadItem[]>([]);
/** Everything still on the phone ("1 scan waiting to upload"), including ones that need a decision. */
export const pendingUploadCount = computed(() => uploadItems.value.length);
/** Scans uploaded in this session (newest first), until the bootstrap lists them. */
export const sessionScans = signal<Scan[]>([]);

/** My scans: session uploads the bootstrap doesn't have yet, then the bootstrap's list. */
export const myScans = computed<Scan[]>(() => {
  const server = bootstrap.value?.myScans ?? [];
  const known = new Set(server.map(s => s.scanId));
  const extra = sessionScans.value.filter(s => !known.has(s.scanId));
  return [...extra, ...server];
});

// ---------------------------------------------------------------- state

/** PDFs of items that couldn't be stored in IndexedDB (kept for this session only). */
const memoryPdfs = new Map<string, QueuedUpload>();
/** Server upload sessions in progress (uploadId + chunk size), by scanId. */
const serverSessions = new Map<string, { uploadId: string; chunkSize: number; received: number }>();
let failures = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let paused = false;
let running: Promise<void> | null = null;
let again = false;
/** Bumped by resetUploadQueue(); an in-flight loop from before stops quietly. */
let generation = 0;

let lastCreatedAt = 0;
/** Strictly increasing, so items queued in the same millisecond keep their order. */
function nextCreatedAt(): number {
  lastCreatedAt = Math.max(Date.now(), lastCreatedAt + 1);
  return lastCreatedAt;
}

function newScanId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `scan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function toItem(q: QueuedUpload, volatile: boolean, prev?: UploadItem): UploadItem {
  return {
    scanId: q.scanId,
    kind: q.kind,
    vehicleHint: q.vehicleHint,
    pages: q.pages,
    size: q.pdf.size,
    capturedAt: q.capturedAt,
    createdAt: q.createdAt,
    phase: q.state === 'failed' ? 'failed' : prev?.phase ?? (q.lastError ? 'retrying' : 'queued'),
    progress: prev?.progress ?? 0,
    error: q.lastError,
    volatile,
  };
}

function patch(scanId: string, p: Partial<UploadItem>): void {
  uploadItems.value = uploadItems.value.map(i => (i.scanId === scanId ? { ...i, ...p } : i));
}

async function readAll(): Promise<QueuedUpload[]> {
  let stored: QueuedUpload[] = [];
  try {
    stored = await (await db()).getAll('uploads');
  } catch {
    /* storage unavailable */
  }
  const ids = new Set(stored.map(s => s.scanId));
  const all = [...stored, ...[...memoryPdfs.values()].filter(m => !ids.has(m.scanId))];
  all.sort((a, b) => a.createdAt - b.createdAt);
  return all;
}

/** Re-reads the queue from IndexedDB into `uploadItems` (keeping live progress). */
export async function loadUploads(): Promise<UploadItem[]> {
  const all = await readAll();
  const prev = new Map(uploadItems.value.map(i => [i.scanId, i]));
  uploadItems.value = all.map(q => toItem(q, memoryPdfs.has(q.scanId), prev.get(q.scanId)));
  return uploadItems.value;
}

async function getQueued(scanId: string): Promise<QueuedUpload | undefined> {
  const mem = memoryPdfs.get(scanId);
  if (mem) return mem;
  try {
    return await (await db()).get('uploads', scanId);
  } catch {
    return undefined;
  }
}

async function saveQueued(q: QueuedUpload): Promise<void> {
  if (memoryPdfs.has(q.scanId)) { memoryPdfs.set(q.scanId, q); return; }
  try { await (await db()).put('uploads', q); } catch { /* ignore */ }
}

async function removeQueued(scanId: string): Promise<void> {
  memoryPdfs.delete(scanId);
  serverSessions.delete(scanId);
  try { await (await db()).delete('uploads', scanId); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- public API

/**
 * Saves a finished PDF on the phone, then starts uploading it. Resolves with
 * the new scanId as soon as the PDF is stored (before any network call).
 */
export async function enqueueUpload(input: EnqueueInput): Promise<string> {
  const q: QueuedUpload = {
    scanId: newScanId(),
    kind: input.kind,
    vehicleHint: input.vehicleHint,
    pdf: input.pdf,
    pages: input.pages,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    createdAt: nextCreatedAt(),
    attempts: 0,
    lastError: null,
    state: 'queued',
  };
  let volatile = false;
  try {
    await (await db()).put('uploads', q);
  } catch {
    // Private mode or storage full: keep it in memory and upload anyway.
    memoryPdfs.set(q.scanId, q);
    volatile = true;
  }
  uploadItems.value = [...uploadItems.value.filter(i => i.scanId !== q.scanId), toItem(q, volatile)];
  failures = 0;
  kickUploads();
  return q.scanId;
}

/** Deletes an item from the phone (My scans › Delete, for permanent failures). */
export async function deleteUpload(scanId: string): Promise<void> {
  await removeQueued(scanId);
  uploadItems.value = uploadItems.value.filter(i => i.scanId !== scanId);
}

/** Tries a permanently failed item again (e.g. after the size limit changed). */
export async function retryUpload(scanId: string): Promise<void> {
  const q = await getQueued(scanId);
  if (!q) return;
  await saveQueued({ ...q, state: 'queued', lastError: null });
  patch(scanId, { phase: 'queued', error: null });
  failures = 0;
  kickUploads();
}

/** True if anything is waiting on this phone (sign-out warns first). */
export async function hasPendingUploads(): Promise<boolean> {
  return (await loadUploads()).length > 0;
}

/** Starts the loop now unless it's running (then it runs once more afterwards). */
export function kickUploads(): void {
  if (running) { again = true; return; }
  void flushUploads();
}

/** Runs the upload loop (or joins the running one) until the queue is empty or a try fails. */
export function flushUploads(): Promise<void> {
  if (running) return running;
  clearTimeout(retryTimer);
  retryTimer = undefined;
  const gen = generation;
  running = (async () => {
    try {
      do {
        again = false;
        await runOnce(gen);
      } while (again && gen === generation && !paused);
    } finally {
      if (gen === generation) running = null;
    }
  })();
  return running;
}

/** Forgets everything in memory (sign-out, tests). IndexedDB is cleared by the store. */
export function resetUploadQueue(): void {
  generation++;
  clearTimeout(retryTimer);
  retryTimer = undefined;
  running = null;
  again = false;
  paused = false;
  failures = 0;
  memoryPdfs.clear();
  serverSessions.clear();
  uploadItems.value = [];
  sessionScans.value = [];
}

let started = false;

/** Called after sign-in: uploads what's waiting now, when back online, and on return to the app. Idempotent. */
export function startUploads(): void {
  if (started) { kickUploads(); return; }
  started = true;
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => { failures = 0; kickUploads(); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') kickUploads();
    });
  }
  // Sign-out wipes the device; a new sign-in resumes a paused queue.
  let lastSession = session.value;
  effect(() => {
    const s = session.value;
    if (s === lastSession) return;
    lastSession = s;
    if (!s) resetUploadQueue();
    else { paused = false; void loadUploads().then(() => kickUploads()); }
  });
  void loadUploads().then(() => kickUploads());
}

// ---------------------------------------------------------------- the loop

async function runOnce(gen: number): Promise<void> {
  const queue = await loadUploads();
  if (gen !== generation) return;
  for (const item of queue) {
    if (gen !== generation || paused) return;
    if (item.phase === 'failed') continue;
    const q = await getQueued(item.scanId);
    if (!q) continue;
    const outcome = await uploadOne(q, gen);
    if (gen !== generation) return;
    if (outcome !== 'done' && outcome !== 'failed') return; // stop; retry later
  }
  failures = 0;
}

type Outcome = 'done' | 'failed' | 'retry' | 'paused';

async function uploadOne(q: QueuedUpload, gen: number): Promise<Outcome> {
  patch(q.scanId, { phase: 'uploading', error: null });
  try {
    const scan = await send(q, gen);
    if (gen !== generation) return 'retry';
    await removeQueued(q.scanId);
    uploadItems.value = uploadItems.value.filter(i => i.scanId !== q.scanId);
    if (scan) sessionScans.value = [scan, ...sessionScans.value.filter(s => s.scanId !== scan.scanId)];
    void refresh();
    return 'done';
  } catch (e) {
    if (gen !== generation) return 'retry';
    const attempts = q.attempts + 1;
    if (e instanceof ApiFailure) {
      if (e.status === 401 || e.status === 403) {
        paused = true;
        await saveQueued({ ...q, attempts, lastError: e.message });
        patch(q.scanId, { phase: 'paused', error: 'Waiting for you to sign in again.' });
        return 'paused';
      }
      if (e.status === 413 || e.status === 400 || e.status === 409) {
        const message = e.status === 413
          ? 'It’s over the 25 MB limit, so it can’t be uploaded. Delete it and scan fewer pages, or upload the files in two visits.'
          : e.message || 'The server couldn’t accept this scan.';
        await saveQueued({ ...q, attempts, state: 'failed', lastError: message });
        serverSessions.delete(q.scanId);
        patch(q.scanId, { phase: 'failed', error: message });
        return 'failed';
      }
    }
    const message = e instanceof NetworkError ? 'No connection' : e instanceof Error ? e.message : String(e);
    await saveQueued({ ...q, attempts, lastError: message });
    patch(q.scanId, { phase: 'retrying', error: message });
    scheduleRetry(gen);
    return 'retry';
  }
}

function scheduleRetry(gen: number): void {
  const delay = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)];
  failures++;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    if (gen === generation) kickUploads();
  }, delay);
}

/** Sends one PDF. Resolves with the server's Scan (null only if the server didn't return one). */
async function send(q: QueuedUpload, gen: number): Promise<Scan | null> {
  const size = q.pdf.size;
  let restarts = 0;
  for (;;) {
    let up = serverSessions.get(q.scanId);
    if (!up) {
      const start = await call('uploadStart', {
        scanId: q.scanId, kind: q.kind, vehicleHint: q.vehicleHint, size, pages: q.pages, capturedAt: q.capturedAt,
      }, { timeoutMs: 30_000 });
      if (start.done) return start.scan ?? null;
      if (!start.uploadId) throw new Error('The server didn’t start the upload.');
      up = { uploadId: start.uploadId, chunkSize: Math.max(1, start.chunkSize || 2 * 1024 * 1024), received: 0 };
      serverSessions.set(q.scanId, up);
      patch(q.scanId, { progress: 0 });
    }
    try {
      for (;;) {
        if (gen !== generation) throw new NetworkError('Stopped');
        const offset = up.received;
        const end = Math.min(size, offset + up.chunkSize);
        const data = await blobToBase64(q.pdf.slice(offset, end));
        const res = await call('uploadChunk', { uploadId: up.uploadId, offset, data }, { timeoutMs: 120_000 });
        if (res.done) {
          serverSessions.delete(q.scanId);
          patch(q.scanId, { progress: 1 });
          if (res.scan) return res.scan;
          // Finished without the row (shouldn't happen): uploadStart is idempotent and returns it.
          const confirm = await call('uploadStart', {
            scanId: q.scanId, kind: q.kind, vehicleHint: q.vehicleHint, size, pages: q.pages, capturedAt: q.capturedAt,
          });
          return confirm.scan ?? null;
        }
        // Always continue from what the server says it has.
        const received = Number(res.received);
        up.received = Number.isFinite(received) ? Math.max(0, Math.min(size, received)) : offset;
        patch(q.scanId, { progress: size ? up.received / size : 0 });
      }
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 404 && restarts < MAX_RESTARTS) {
        // The server's upload session expired: start again with the same scanId.
        serverSessions.delete(q.scanId);
        restarts++;
        continue;
      }
      if (e instanceof ApiFailure && e.status === 404) {
        serverSessions.delete(q.scanId);
        throw new NetworkError('The upload kept expiring');
      }
      throw e;
    }
  }
}

/** For the upload screen: what's happening to one scanId right now. */
export function uploadStatus(scanId: string): { phase: UploadPhase | 'done' | 'unknown'; progress: number; error: string | null; scan: Scan | null } {
  const item = uploadItems.value.find(i => i.scanId === scanId);
  if (item) return { phase: item.phase, progress: item.progress, error: item.error, scan: null };
  const scan = sessionScans.value.find(s => s.scanId === scanId) ?? null;
  return { phase: scan ? 'done' : 'unknown', progress: scan ? 1 : 0, error: null, scan };
}
