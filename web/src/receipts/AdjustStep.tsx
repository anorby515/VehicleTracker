/**
 * Spec 7.1 step 4: the captured page with four draggable corner handles,
 * pre-placed on the detected edges, and a magnifier while dragging. Then
 * perspective correction (warp.ts, long edge ≈ 2,000 px) and a cleanup
 * filter (filters.ts: "Document" by default, or "Photo").
 *
 * Handles are real buttons: 44 pt hit areas, VoiceOver names ("Top left
 * corner") and arrow-key nudging (Shift for bigger steps).
 */

import type { JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { CV } from '../scanner/cv';
import { FILTER_LABELS, type FilterMode } from '../scanner/filters';
import { CORNERS, CORNER_LABELS, type Corner, type Pt, type Quad, quadPoints } from '../scanner/geometry';
import { canvasToBlob, drawScaled, freeCanvas } from '../scanner/image';
import { type ScannedPage, type SourceImage, detectOnSource, freeSource, loadSource, processPage } from '../scanner/pipeline';
import { Icon } from '../ui/Icon';
import { StepBar } from './common';
import './AdjustStep.css';

export interface AdjustStepProps {
  still: Blob;
  origin: 'camera' | 'file';
  /** Resolves with OpenCV, or null when it couldn't load (then corners start at a default inset). */
  getCv: () => Promise<CV | null>;
  cvLoading: boolean;
  title?: string;
  retakeLabel?: string;
  onRetake: () => void;
  onUse: (page: ScannedPage) => void;
}

type Phase = 'loading' | 'ready' | 'processing' | 'error';

const LOUPE = 128;
const ZOOM = 2.5;

export function AdjustStep(props: AdjustStepProps): JSX.Element {
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [quad, setQuad] = useState<Quad | null>(null);
  const [found, setFound] = useState(true);
  const [filter, setFilter] = useState<FilterMode>('document');
  const [preview, setPreview] = useState<string | null>(null);
  const [frame, setFrame] = useState<{ w: number; h: number } | null>(null);
  const [drag, setDrag] = useState<{ corner: Corner; pointer: Pt } | null>(null);

  const sourceRef = useRef<SourceImage | null>(null);
  const displayRef = useRef<HTMLCanvasElement | null>(null);
  const cvRef = useRef<CV | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const loupeRef = useRef<HTMLCanvasElement>(null);
  const grab = useRef<{ dx: number; dy: number; id: number } | null>(null);

  // Decode the still, find the edges.
  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    (async () => {
      try {
        const src = await loadSource(props.still, props.origin);
        if (cancelled) { freeSource(src); return; }
        sourceRef.current = src;
        const display = drawScaled(src.canvas, 1400);
        displayRef.current = display;
        url = URL.createObjectURL(await canvasToBlob(display, 'image/jpeg', 0.85));
        if (cancelled) return;
        setPreview(url);
        const cv = await props.getCv();
        if (cancelled) return;
        cvRef.current = cv;
        const d = detectOnSource(cv, src);
        setQuad(d.quad);
        setFound(d.found);
        setPhase('ready');
      } catch (e) {
        if (!cancelled) { setError(e instanceof Error ? e.message : 'That picture couldn’t be opened.'); setPhase('error'); }
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
      freeSource(sourceRef.current);
      sourceRef.current = null;
      freeCanvas(displayRef.current);
      displayRef.current = null;
    };
  }, [props.still]);

  // Fit the page into the stage.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const src = sourceRef.current;
    if (!stage || !src || !preview) return;
    const fit = () => {
      const pad = 24;
      const aw = Math.max(50, stage.clientWidth - pad * 2), ah = Math.max(50, stage.clientHeight - pad * 2);
      const s = Math.min(aw / src.width, ah / src.height);
      setFrame({ w: Math.round(src.width * s), h: Math.round(src.height * s) });
    };
    fit();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
    ro?.observe(stage);
    return () => ro?.disconnect();
  }, [preview]);

  const src = sourceRef.current;

  const toImage = (clientX: number, clientY: number): Pt => {
    const r = frameRef.current!.getBoundingClientRect();
    const s = sourceRef.current!;
    return {
      x: Math.max(0, Math.min(s.width, ((clientX - r.left) / r.width) * s.width)),
      y: Math.max(0, Math.min(s.height, ((clientY - r.top) / r.height) * s.height)),
    };
  };

  const moveCorner = (c: Corner, p: Pt) => {
    setQuad(q => (q ? { ...q, [c]: p } : q));
  };

  const onPointerDown = (c: Corner) => (e: JSX.TargetedPointerEvent<HTMLButtonElement>) => {
    if (!quad || phase !== 'ready') return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const p = toImage(e.clientX, e.clientY);
    grab.current = { dx: quad[c].x - p.x, dy: quad[c].y - p.y, id: e.pointerId };
    setDrag({ corner: c, pointer: { x: e.clientX, y: e.clientY } });
  };

  const onPointerMove = (c: Corner) => (e: JSX.TargetedPointerEvent<HTMLButtonElement>) => {
    if (!grab.current || grab.current.id !== e.pointerId || drag?.corner !== c) return;
    const s = sourceRef.current!;
    const p = toImage(e.clientX, e.clientY);
    moveCorner(c, {
      x: Math.max(0, Math.min(s.width, p.x + grab.current.dx)),
      y: Math.max(0, Math.min(s.height, p.y + grab.current.dy)),
    });
    setDrag({ corner: c, pointer: { x: e.clientX, y: e.clientY } });
  };

  const endDrag = (e: JSX.TargetedPointerEvent<HTMLButtonElement>) => {
    if (grab.current?.id !== e.pointerId) return;
    grab.current = null;
    setDrag(null);
  };

  const onKeyDown = (c: Corner) => (e: JSX.TargetedKeyboardEvent<HTMLButtonElement>) => {
    if (!quad || !src) return;
    const step = Math.max(1, Math.round(Math.max(src.width, src.height) * (e.shiftKey ? 0.02 : 0.005)));
    const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const m = d[e.key];
    if (!m) return;
    e.preventDefault();
    moveCorner(c, {
      x: Math.max(0, Math.min(src.width, quad[c].x + m[0])),
      y: Math.max(0, Math.min(src.height, quad[c].y + m[1])),
    });
  };

  // Magnifier while dragging.
  useEffect(() => {
    const loupe = loupeRef.current;
    const display = displayRef.current;
    const s = sourceRef.current;
    if (!drag || !loupe || !display || !s || !quad) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const size = Math.round(LOUPE * dpr);
    if (loupe.width !== size) { loupe.width = size; loupe.height = size; }
    const g = loupe.getContext('2d');
    if (!g) return;
    const p = quad[drag.corner];
    const f = display.width / s.width;
    const fr = frameRef.current!.getBoundingClientRect();
    // Source pixels per loupe pixel: show ZOOM × what's on screen.
    const screenScale = fr.width / s.width;
    const span = (LOUPE / (screenScale * ZOOM)) * f;
    g.fillStyle = '#000';
    g.fillRect(0, 0, size, size);
    g.imageSmoothingQuality = 'high';
    g.drawImage(display, p.x * f - span / 2, p.y * f - span / 2, span, span, 0, 0, size, size);
    // The outline and the crosshair.
    const toL = (q: Pt) => ({ x: ((q.x * f - (p.x * f - span / 2)) / span) * size, y: ((q.y * f - (p.y * f - span / 2)) / span) * size });
    g.strokeStyle = '#0a84ff';
    g.lineWidth = 2 * dpr;
    g.beginPath();
    quadPoints(quad).map(toL).forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
    g.closePath();
    g.stroke();
    g.strokeStyle = '#fff';
    g.lineWidth = 1.5 * dpr;
    g.beginPath();
    g.moveTo(size / 2 - 10 * dpr, size / 2); g.lineTo(size / 2 + 10 * dpr, size / 2);
    g.moveTo(size / 2, size / 2 - 10 * dpr); g.lineTo(size / 2, size / 2 + 10 * dpr);
    g.stroke();
  }, [drag, quad]);

  const use = async () => {
    const s = sourceRef.current;
    if (!s || !quad) return;
    setPhase('processing');
    setError(null);
    try {
      // Let the "Cleaning up…" state paint before the heavy work.
      await new Promise(r => setTimeout(r, 30));
      const page = await processPage(cvRef.current, s, quad, filter);
      props.onUse(page);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t clean up the page. Try again.');
      setPhase('ready');
    }
  };

  // Loupe on the side away from the finger.
  const stageRect = stageRef.current?.getBoundingClientRect();
  const fingerOnLeft = drag && stageRect && drag.pointer.x < stageRect.left + stageRect.width / 2;

  return (
    <div class="adj">
      <StepBar title={props.title ?? 'Adjust corners'} />
      <div class="adj-stage" ref={stageRef}>
        {(phase === 'loading' || !preview || !frame) && phase !== 'error' && (
          <div class="adj-status" role="status">
            <span class="spinner" aria-hidden="true" />
            <span>{props.cvLoading && preview ? 'Getting the scanner ready…' : 'Finding the edges…'}</span>
          </div>
        )}
        {phase === 'error' && <p class="adj-status" role="alert">{error}</p>}
        {preview && frame && src && (
          <div class="adj-frame" ref={frameRef} style={{ width: `${frame.w}px`, height: `${frame.h}px` }}>
            <img class="adj-img" src={preview} alt="The photo you took" draggable={false} />
            {quad && (
              <svg class="adj-svg" viewBox={`0 0 ${src.width} ${src.height}`} preserveAspectRatio="none" aria-hidden="true">
                <path
                  class="adj-shade"
                  fill-rule="evenodd"
                  d={`M0 0H${src.width}V${src.height}H0Z M${quadPoints(quad).map(p => `${p.x} ${p.y}`).join(' L')}Z`}
                />
                <polygon class="adj-outline" points={quadPoints(quad).map(p => `${p.x},${p.y}`).join(' ')} vector-effect="non-scaling-stroke" />
              </svg>
            )}
            {quad && phase !== 'loading' && CORNERS.map(c => (
              <button
                key={c}
                type="button"
                class={`adj-handle${drag?.corner === c ? ' adj-handle-active' : ''}`}
                style={{ left: `${(quad[c].x / src.width) * 100}%`, top: `${(quad[c].y / src.height) * 100}%` }}
                aria-label={CORNER_LABELS[c]}
                aria-describedby="adj-help"
                disabled={phase === 'processing'}
                onPointerDown={onPointerDown(c)}
                onPointerMove={onPointerMove(c)}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onKeyDown={onKeyDown(c)}
              >
                <span class="adj-dot" />
              </button>
            ))}
          </div>
        )}
        {drag && (
          <canvas
            ref={loupeRef}
            class={`adj-loupe ${fingerOnLeft ? 'adj-loupe-right' : 'adj-loupe-left'}`}
            style={{ width: `${LOUPE}px`, height: `${LOUPE}px` }}
            aria-hidden="true"
          />
        )}
      </div>

      <div class="adj-controls">
        <p id="adj-help" class="footnote adj-help">
          {phase === 'ready' && !found
            ? 'We couldn’t find the edges. Drag each corner to a corner of the receipt.'
            : 'Drag the corners to the edges of the page if they’re off.'}
        </p>
        {error && phase !== 'error' && <p class="adj-error" role="alert">{error}</p>}
        <div class="adj-filters" role="radiogroup" aria-label="Clean-up style">
          {(['document', 'photo'] as FilterMode[]).map(f => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={filter === f}
              class={`adj-filter${filter === f ? ' adj-filter-on' : ''}`}
              onClick={() => setFilter(f)}
            >
              <Icon name={f === 'document' ? 'doc' : 'photo'} size={18} />
              {FILTER_LABELS[f]}
            </button>
          ))}
        </div>
        <div class="adj-actions">
          <button type="button" class="btn" onClick={props.onRetake} disabled={phase === 'processing'}>{props.retakeLabel ?? 'Retake'}</button>
          <button type="button" class="btn btn-primary adj-use" onClick={() => void use()} disabled={phase !== 'ready' || !quad}>
            {phase === 'processing' ? <><span class="spinner adj-spin" aria-hidden="true" /> Cleaning up…</> : 'Use this page'}
          </button>
        </div>
      </div>
    </div>
  );
}
