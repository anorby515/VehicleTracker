/**
 * Loads OpenCV.js (~10 MB, WASM embedded) from its versioned static file
 * (vite.config.ts › OPENCV_PATH) with a classic <script>, only when the
 * scanner opens. The service worker caches it on first use (sw.ts, cache
 * "opencv"); prefetchScanner() warms that cache in the background so the
 * scanner also works offline.
 */

import type { CV } from './cv';

export const OPENCV_URL = `${import.meta.env.BASE_URL}${__OPENCV_PATH__}`;

let loading: Promise<CV> | null = null;

/** The OpenCV module (loads it on first call). Rejects if it can't load (offline on first use). */
export function loadOpenCv(timeoutMs = 90_000): Promise<CV> {
  if (!loading) {
    loading = doLoad(timeoutMs);
    loading.catch(() => { loading = null; });
  }
  return loading;
}

/** True once OpenCV is ready (no loading screen needed). */
export function openCvReady(): boolean {
  const g = globalThis as unknown as { cv?: { Mat?: unknown; then?: unknown } };
  return !!g.cv?.Mat && typeof g.cv.then !== 'function';
}

async function doLoad(timeoutMs: number): Promise<CV> {
  const g = window as unknown as { cv?: unknown };
  if (!g.cv) {
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = OPENCV_URL;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { s.remove(); reject(new Error('The scanner couldn’t load. Check your connection and try again.')); };
      document.head.appendChild(s);
    });
  }
  return withTimeout(ready(g.cv), timeoutMs, 'The scanner took too long to start.');
}

/** The Emscripten module is a thenable that resolves to itself; wait for it without looping. */
function ready(mod: unknown): Promise<CV> {
  return new Promise<CV>((resolve, reject) => {
    const m = mod as { Mat?: unknown; then?: (f: (x: CV) => void) => void; onRuntimeInitialized?: () => void } | undefined;
    if (!m) { reject(new Error('The scanner couldn’t start.')); return; }
    if (typeof m.then === 'function') {
      m.then(r => {
        delete (r as { then?: unknown }).then;
        (window as unknown as { cv: CV }).cv = r;
        resolve(r);
      });
      return;
    }
    if (m.Mat) { resolve(m as unknown as CV); return; }
    m.onRuntimeInitialized = () => resolve(m as unknown as CV);
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

let prefetchScheduled = false;

/**
 * Downloads OpenCV in the background (online, after ~10 s idle) so the
 * service worker caches it before the first scan. Skipped when it's already
 * cached, on Save Data, and in automated test browsers.
 */
export function prefetchScanner(delayMs = 10_000): void {
  if (prefetchScheduled || typeof window === 'undefined') return;
  prefetchScheduled = true;
  try {
    if (navigator.webdriver) return;
    const conn = (navigator as unknown as { connection?: { saveData?: boolean } }).connection;
    if (conn?.saveData) return;
  } catch {
    return;
  }
  const run = async () => {
    if (!navigator.onLine || loading) return;
    try {
      if ('caches' in window && (await caches.match(OPENCV_URL))) return;
      await fetch(OPENCV_URL, { credentials: 'same-origin' });
    } catch {
      prefetchScheduled = false; // try again next start
    }
  };
  setTimeout(() => {
    const idle = (window as unknown as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
    if (idle) idle(() => void run(), { timeout: 5_000 });
    else void run();
  }, delayMs);
}
