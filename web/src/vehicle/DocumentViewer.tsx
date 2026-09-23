/**
 * Receipt / document viewer (spec 6.3), also used by My scans. Opens as a
 * stacked sheet (component state, not a route).
 *
 * - Bytes come from the IndexedDB docs cache (last 20 viewed) or
 *   `getFile {purpose: 'document'}` through the App API.
 * - Images show in an <img>. PDFs render page by page into canvases with
 *   pdf.js (legacy build), lazily as they scroll near the screen; far-away
 *   canvases are freed. Never <iframe>/<embed>: iOS shows only page 1.
 * - Pinch-zoom: iOS gesture events (e.scale), or two-pointer pinch via
 *   Pointer Events elsewhere, on a transform while the fingers move, then
 *   committed as a layout zoom (so scrolling covers the zoomed page). Plus
 *   − / + buttons and double-tap to toggle 2×.
 * - "Open in Google Drive" is always there as the fallback.
 */

import type { JSX } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { ApiFailure, NetworkError, base64ToBlob, call } from '../api/client';
import { cacheDoc, getCachedDoc } from '../lib/db';
import { openPdf } from '../lib/pdfjs';
import { online } from '../state/store';
import { Icon } from '../ui/Icon';
import { Sheet } from '../ui/Sheet';
import { canvasScale, clampZoom, distance, driveUrl, nextZoomStep, scrollForZoom } from './viewerMath';
import './DocumentViewer.css';

export interface DocumentViewerProps {
  /** Drive file ID (must be on the API's allowlist). */
  fileId: string;
  /** Heading, e.g. the document type or file name. */
  title: string;
  onClose: () => void;
}

type Content =
  | { kind: 'pdf'; bytes: Uint8Array }
  | { kind: 'image'; url: string }
  | { kind: 'other' };

type LoadState =
  | { s: 'loading' }
  | { s: 'ready'; content: Content }
  | { s: 'error'; reason: 'offline' | 'forbidden' | 'too_large' | 'other'; message: string };

/** The document's bytes: cached copy first, else the API (then cached). */
export async function loadDocument(fileId: string): Promise<{ blob: Blob; mimeType: string; name: string }> {
  const cached = await getCachedDoc(fileId);
  if (cached?.blob && cached.blob.size) return { blob: cached.blob, mimeType: cached.mimeType, name: cached.name };
  const res = await call('getFile', { fileId, purpose: 'document' });
  const blob = base64ToBlob(res.data, res.mimeType || 'application/octet-stream');
  await cacheDoc({ fileId, name: res.name, mimeType: res.mimeType, blob, viewedAt: Date.now() });
  return { blob, mimeType: res.mimeType, name: res.name };
}

async function toContent(blob: Blob, mimeType: string, name: string): Promise<Content> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const isPdf = /pdf/i.test(mimeType) || /\.pdf$/i.test(name) || (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46);
  if (isPdf) return { kind: 'pdf', bytes };
  if (/^image\//i.test(mimeType) || /\.(jpe?g|png|gif|heic|heif|webp)$/i.test(name)) {
    return { kind: 'image', url: URL.createObjectURL(blob.type ? blob : new Blob([bytes], { type: mimeType })) };
  }
  return { kind: 'other' };
}

export function DocumentViewerSheet(props: DocumentViewerProps): JSX.Element {
  const [state, setState] = useState<LoadState>({ s: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let imageUrl: string | null = null;
    setState({ s: 'loading' });
    (async () => {
      try {
        const d = await loadDocument(props.fileId);
        const content = await toContent(d.blob, d.mimeType, d.name);
        if (content.kind === 'image') imageUrl = content.url;
        if (cancelled) { if (imageUrl) URL.revokeObjectURL(imageUrl); return; }
        setState({ s: 'ready', content });
      } catch (e) {
        if (cancelled) return;
        setState(errorState(e));
      }
    })();
    return () => {
      cancelled = true;
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [props.fileId, attempt]);

  // Offline and not cached: try again by itself when the connection is back.
  const isOnline = online.value;
  useEffect(() => {
    if (isOnline && state.s === 'error' && state.reason === 'offline') setAttempt(a => a + 1);
  }, [isOnline]);

  const drive = driveUrl(props.fileId);

  return (
    <Sheet title={props.title} onClose={props.onClose} class="dv-sheet">
      {state.s === 'loading' && (
        <div class="dv-status" role="status">
          <span class="spinner" aria-hidden="true" />
          <p>Loading…</p>
        </div>
      )}
      {state.s === 'error' && (
        <div class="dv-status">
          <Icon name={state.reason === 'offline' ? 'refresh' : 'doc'} size={34} class="dv-status-icon" />
          <p class="dv-status-text">{state.message}</p>
          {state.reason === 'offline' || state.reason === 'other'
            ? <button type="button" class="btn" onClick={() => setAttempt(a => a + 1)}>Try again</button>
            : null}
          <a class="btn btn-plain" href={drive} target="_blank" rel="noopener">
            <Icon name="drive" size={20} /> Open in Google Drive
          </a>
        </div>
      )}
      {state.s === 'ready' && state.content.kind === 'other' && (
        <div class="dv-status">
          <Icon name="doc" size={34} class="dv-status-icon" />
          <p class="dv-status-text">This kind of file can’t be shown in the app.</p>
          <a class="btn" href={drive} target="_blank" rel="noopener">
            <Icon name="drive" size={20} /> Open in Google Drive
          </a>
        </div>
      )}
      {state.s === 'ready' && state.content.kind !== 'other' && (
        <ZoomViewer content={state.content} title={props.title} driveHref={drive} />
      )}
    </Sheet>
  );
}

function errorState(e: unknown): LoadState {
  if (e instanceof NetworkError) {
    return { s: 'error', reason: 'offline', message: 'This receipt isn’t saved on this phone yet. Connect to view it.' };
  }
  if (e instanceof ApiFailure) {
    if (e.status === 403) return { s: 'error', reason: 'forbidden', message: 'This file can’t be opened in the app. You can still open it in Google Drive.' };
    if (e.status === 413) return { s: 'error', reason: 'too_large', message: 'This file is too big to show in the app. Open it in Google Drive instead.' };
    return { s: 'error', reason: 'other', message: e.message || 'Something went wrong loading this file.' };
  }
  return { s: 'error', reason: 'other', message: 'Something went wrong loading this file.' };
}

// ---------------------------------------------------------------- zoom

interface GestureEventLike extends UIEvent { scale: number; clientX: number; clientY: number }

function ZoomViewer(props: { content: Exclude<Content, { kind: 'other' }>; title: string; driveHref: string }): JSX.Element {
  const viewport = useRef<HTMLDivElement>(null);
  const contentEl = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  const pendingScroll = useRef<{ left: number; top: number } | null>(null);

  /** Zoom to `to`, keeping the point at (fx, fy) in the viewport still. */
  const zoomAt = useCallback((to: number, fx?: number, fy?: number) => {
    const vp = viewport.current;
    const from = zoomRef.current;
    const z = clampZoom(to);
    if (!vp || Math.abs(z - from) < 0.001) return;
    const focal = { x: fx ?? vp.clientWidth / 2, y: fy ?? vp.clientHeight / 2 };
    pendingScroll.current = scrollForZoom({ left: vp.scrollLeft, top: vp.scrollTop }, focal, from, z);
    zoomRef.current = z;
    setZoom(z);
  }, []);

  useLayoutEffect(() => {
    const vp = viewport.current;
    const p = pendingScroll.current;
    if (vp && p) {
      vp.scrollLeft = p.left;
      vp.scrollTop = p.top;
      pendingScroll.current = null;
    }
  }, [zoom]);

  // Pinch: iOS gesture events, else two pointers. Live feedback is a CSS
  // transform around the fingers; the zoom is committed when they lift.
  useEffect(() => {
    const vp = viewport.current;
    const el = contentEl.current;
    if (!vp || !el) return;
    let live: { zoom0: number; fx: number; fy: number; origin: string } | null = null;
    let liveScale = 1;

    const rel = (x: number, y: number) => {
      const r = vp.getBoundingClientRect();
      return { x: x - r.left, y: y - r.top };
    };
    const begin = (x: number, y: number) => {
      const f = rel(x, y);
      live = { zoom0: zoomRef.current, fx: f.x, fy: f.y, origin: `${vp.scrollLeft + f.x}px ${vp.scrollTop + f.y}px` };
      liveScale = 1;
      el.style.transformOrigin = live.origin;
      el.style.willChange = 'transform';
    };
    const update = (scale: number) => {
      if (!live) return;
      liveScale = clampZoom(live.zoom0 * scale) / live.zoom0;
      el.style.transform = `scale(${liveScale})`;
    };
    const end = () => {
      if (!live) return;
      const { zoom0, fx, fy } = live;
      live = null;
      el.style.transform = '';
      el.style.willChange = '';
      zoomAt(zoom0 * liveScale, fx, fy);
    };

    const cleanups: (() => void)[] = [];
    const on = <K extends string>(type: K, fn: (e: Event) => void, opts: AddEventListenerOptions = { passive: false }) => {
      vp.addEventListener(type, fn, opts);
      cleanups.push(() => vp.removeEventListener(type, fn, opts));
    };

    const iosGestures = 'ongesturestart' in window;
    if (iosGestures) {
      on('gesturestart', e => { e.preventDefault(); const g = e as GestureEventLike; begin(g.clientX, g.clientY); });
      on('gesturechange', e => { e.preventDefault(); update((e as GestureEventLike).scale); });
      on('gestureend', e => { e.preventDefault(); end(); });
    }

    // Pointers: pinch (when not iOS), and double-tap on every platform.
    // Double-tap toggles 1× ↔ 2×. Some browsers send both our tap pair and a
    // dblclick for the same double-tap, so a second toggle right after is ignored.
    let lastToggle = 0;
    const toggleAt = (x: number, y: number) => {
      const now = Date.now();
      if (now - lastToggle < 450) return;
      lastToggle = now;
      const f = rel(x, y);
      zoomAt(zoomRef.current > 1.01 ? 1 : 2, f.x, f.y);
    };

    const pts = new Map<number, { x: number; y: number }>();
    let pinch0 = 0;
    let lastTap: { t: number; x: number; y: number } | null = null;
    let down: { x: number; y: number; t: number } | null = null;
    on('pointerdown', e => {
      const p = e as PointerEvent;
      pts.set(p.pointerId, { x: p.clientX, y: p.clientY });
      down = pts.size === 1 ? { x: p.clientX, y: p.clientY, t: Date.now() } : null;
      if (!iosGestures && pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch0 = distance(a, b) || 1;
        begin((a.x + b.x) / 2, (a.y + b.y) / 2);
      }
    }, { passive: true });
    on('pointermove', e => {
      const p = e as PointerEvent;
      if (!pts.has(p.pointerId)) return;
      pts.set(p.pointerId, { x: p.clientX, y: p.clientY });
      if (!iosGestures && pts.size === 2 && live) {
        const [a, b] = [...pts.values()];
        update(distance(a, b) / pinch0);
      }
    }, { passive: true });
    const lift = (e: Event) => {
      const p = e as PointerEvent;
      const wasPinch = pts.size >= 2;
      pts.delete(p.pointerId);
      if (!iosGestures && live && pts.size < 2) end();
      if (e.type !== 'pointerup' || wasPinch || !down || p.pointerType === 'mouse') { if (pts.size === 0) down = null; return; }
      const moved = Math.hypot(p.clientX - down.x, p.clientY - down.y) > 12;
      const quick = Date.now() - down.t < 300;
      down = null;
      if (moved || !quick) { lastTap = null; return; }
      const now = Date.now();
      if (lastTap && now - lastTap.t < 320 && Math.hypot(p.clientX - lastTap.x, p.clientY - lastTap.y) < 30) {
        lastTap = null;
        toggleAt(p.clientX, p.clientY);
      } else {
        lastTap = { t: now, x: p.clientX, y: p.clientY };
      }
    };
    on('pointerup', lift, { passive: true });
    on('pointercancel', lift, { passive: true });
    on('dblclick', e => {
      const m = e as MouseEvent;
      toggleAt(m.clientX, m.clientY);
    });
    // Trackpad pinch on desktop arrives as ctrl + wheel.
    on('wheel', e => {
      const w = e as WheelEvent;
      if (!w.ctrlKey) return;
      w.preventDefault();
      const f = rel(w.clientX, w.clientY);
      zoomAt(zoomRef.current * Math.exp(-w.deltaY / 200), f.x, f.y);
    });

    return () => cleanups.forEach(fn => fn());
  }, [zoomAt]);

  const pct = `${Math.round(zoom * 100)}%`;
  return (
    <div class="dv">
      <div class="dv-viewport" ref={viewport} tabIndex={0} aria-label={`${props.title}. Pinch or double-tap to zoom.`}>
        <div class="dv-content" ref={contentEl} style={{ width: `${zoom * 100}%` }}>
          {props.content.kind === 'image'
            ? <img class="dv-image" src={props.content.url} alt={props.title} draggable={false} />
            : <PdfPages bytes={props.content.bytes} zoom={zoom} root={viewport} driveHref={props.driveHref} />}
        </div>
      </div>
      <div class="dv-toolbar">
        <button type="button" class="icon-btn" aria-label="Zoom out" disabled={zoom <= 1.001} onClick={() => zoomAt(nextZoomStep(zoomRef.current, -1))}>
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M5 12h14" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" fill="none" />
          </svg>
        </button>
        <span class="dv-zoom num" aria-live="polite" aria-label={`Zoom ${pct}`}>{pct}</span>
        <button type="button" class="icon-btn" aria-label="Zoom in" disabled={zoom >= 3.999} onClick={() => zoomAt(nextZoomStep(zoomRef.current, 1))}>
          <Icon name="plus" />
        </button>
        <a class="btn btn-plain dv-drive" href={props.driveHref} target="_blank" rel="noopener">
          <Icon name="drive" size={20} /> Open in Google Drive
        </a>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- PDF pages

interface PageSize { w: number; h: number }

function PdfPages(props: { bytes: Uint8Array; zoom: number; root: { current: HTMLDivElement | null }; driveHref: string }): JSX.Element {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let opened: PDFDocumentProxy | null = null;
    (async () => {
      try {
        // pdf.js transfers the buffer to its worker, so give it a copy.
        opened = await openPdf(props.bytes.slice());
        if (cancelled) { void opened.loadingTask.destroy(); return; }
        const list: PageSize[] = [];
        for (let i = 1; i <= opened.numPages; i++) {
          const page = await opened.getPage(i);
          const vp = page.getViewport({ scale: 1 });
          list.push({ w: vp.width, h: vp.height });
        }
        if (cancelled) return;
        setSizes(list);
        setDoc(opened);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      void opened?.loadingTask.destroy();
    };
  }, [props.bytes]);

  if (failed) {
    return (
      <div class="dv-status">
        <p class="dv-status-text">This PDF couldn’t be shown here.</p>
        <a class="btn" href={props.driveHref} target="_blank" rel="noopener"><Icon name="drive" size={20} /> Open in Google Drive</a>
      </div>
    );
  }
  if (!doc) {
    return <div class="dv-status" role="status"><span class="spinner" aria-hidden="true" /><p>Opening PDF…</p></div>;
  }
  return (
    <div class="dv-pages">
      {sizes.map((s, i) => (
        <PdfPage key={i} doc={doc} n={i + 1} of={sizes.length} size={s} zoom={props.zoom} root={props.root} />
      ))}
    </div>
  );
}

function releaseCanvas(c: HTMLCanvasElement): void {
  c.width = 0;
  c.height = 0;
  c.remove();
}

function PdfPage(props: { doc: PDFDocumentProxy; n: number; of: number; size: PageSize; zoom: number; root: { current: HTMLDivElement | null } }): JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [rendered, setRendered] = useState(false);
  const rendersAtZoom = useRef<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') { setNear(true); return; }
    const io = new IntersectionObserver(
      entries => setNear(entries.some(e => e.isIntersecting)),
      { root: props.root.current, rootMargin: '100% 50% 100% 50%' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (!near) {
      // Far off screen: free the canvas memory (iOS caps total canvas memory).
      el.querySelectorAll('canvas').forEach(releaseCanvas);
      rendersAtZoom.current = null;
      setRendered(false);
      return;
    }
    if (rendersAtZoom.current === props.zoom) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    // Re-render after zooming settles; first render straight away.
    const delay = rendersAtZoom.current === null ? 0 : 180;
    const timer = setTimeout(async () => {
      try {
        const page = await props.doc.getPage(props.n);
        if (cancelled) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 3);
        const scale = canvasScale(props.size.w, props.size.h, el.offsetWidth || 320, dpr);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.className = 'dv-canvas';
        canvas.setAttribute('aria-hidden', 'true');
        task = page.render({ canvas, viewport });
        await task.promise;
        if (cancelled) { releaseCanvas(canvas); return; }
        el.querySelectorAll('canvas').forEach(releaseCanvas);
        el.appendChild(canvas);
        rendersAtZoom.current = props.zoom;
        setRendered(true);
      } catch {
        /* cancelled or failed: the placeholder stays */
      }
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      task?.cancel();
    };
  }, [near, props.zoom]);

  useEffect(() => () => { box.current?.querySelectorAll('canvas').forEach(releaseCanvas); }, []);

  return (
    <div
      ref={box}
      class={`dv-page${rendered ? ' is-rendered' : ''}`}
      style={{ aspectRatio: `${props.size.w} / ${props.size.h}` }}
      role="img"
      aria-label={`Page ${props.n} of ${props.of}`}
    />
  );
}
