/**
 * Spec 7.1 step 3: live rear-camera preview with the receipt outlined in
 * real time (detect.ts on a ~480 px copy, ~6 fps), a shutter that always
 * works, auto-capture when the outline holds steady for about a second, and
 * the torch when the phone offers it.
 *
 * If the camera can't open, the iPhone's own camera (file input with
 * capture="environment") takes the photo instead; edge detection still runs
 * on that still in the Adjust step.
 */

import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { CV } from '../scanner/cv';
import { freeMat } from '../scanner/cv';
import { GOOD_CONFIDENCE, MIN_CONFIDENCE, detectDocument } from '../scanner/detect';
import { type Quad, isSteady, maxCornerDistance, quadPoints, scaleQuad } from '../scanner/geometry';
import { CameraSession, cameraErrorMessage } from '../scanner/camera';
import { ctx2d, fitSize, freeCanvas, makeCanvas, matFromCanvas } from '../scanner/image';
import { Icon } from '../ui/Icon';
import { autoCaptureOn, setAutoCapture } from './state';
import './CameraStep.css';

export interface CameraStepProps {
  camera: CameraSession;
  /** The stream being opened by the tap that brought us here (null → fallback / needs a tap). */
  opening: Promise<MediaStream> | null;
  cv: CV | null;
  cvStatus: 'idle' | 'loading' | 'ready' | 'failed';
  pageCount: number;
  /** 1-based page number being retaken, if any. */
  retakePage: number | null;
  /** What we're photographing ("receipt" or "photo" for owner entries). */
  subject: 'receipt' | 'photo';
  onStill: (blob: Blob, origin: 'camera' | 'file') => void;
  onClose: () => void;
  onShowPages: () => void;
  /** Tap handler: open the camera again (after it failed or iOS stopped it). */
  onRetryCamera: () => void;
}

type CamState = 'starting' | 'live' | 'fallback' | 'ended';

const DETECT_EVERY_MS = 150;
const STEADY_MS = 1000;
/** For a further page, auto-capture waits until the outline moves this much (share of the diagonal) or is lost. */
const NEW_PAGE_MOVE = 0.1;

export function CameraStep(props: CameraStepProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<CamState>(props.opening ? 'starting' : props.camera.current ? 'live' : 'fallback');
  const [error, setError] = useState<string | null>(props.opening || props.camera.current ? null : cameraErrorMessage(new Error()));
  const [videoReady, setVideoReady] = useState(false);
  const [auto, setAuto] = useState(autoCaptureOn);
  const [torch, setTorch] = useState(false);
  const [torchOk, setTorchOk] = useState(false);
  const [hint, setHint] = useState<'none' | 'found' | 'steady' | 'swap'>('none');
  const [capturing, setCapturing] = useState(false);
  const capturingRef = useRef(false);
  // Latest props and toggle for the detection loop.
  const propsRef = useRef(props);
  propsRef.current = props;
  const autoRef = useRef(auto);
  autoRef.current = auto;

  // Attach the stream.
  useEffect(() => {
    let cancelled = false;
    const attach = (s: MediaStream) => {
      if (cancelled) return;
      const v = videoRef.current;
      if (!v) return;
      v.srcObject = s;
      v.muted = true;
      v.setAttribute('playsinline', '');
      void v.play().catch(() => { /* autoplay of a muted inline video is allowed; ignore */ });
      setState('live');
      setError(null);
      setTorchOk(props.camera.torchSupported());
      const track = s.getVideoTracks()[0];
      track?.addEventListener('ended', () => { if (!cancelled) { setState('ended'); setVideoReady(false); } }, { once: true });
    };
    const current = props.camera.current;
    if (current) {
      props.camera.resume();
      attach(current);
    } else if (props.opening) {
      setState('starting');
      props.opening.then(attach, e => {
        if (cancelled) return;
        setError(cameraErrorMessage(e));
        setState('fallback');
      });
    }
    return () => {
      cancelled = true;
      const v = videoRef.current;
      if (v) { v.pause(); v.srcObject = null; }
    };
  }, [props.opening]);

  // Live edge detection + auto-capture.
  useEffect(() => {
    const cv = props.cv;
    const v = videoRef.current;
    if (!cv || !videoReady || state !== 'live' || !v) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let prior: Quad | null = null;
    let prev: Quad | null = null;
    let steadySince = 0;
    let lastHint: typeof hint = 'none';
    // A further page (not a retake): don't re-capture the page that's still in view.
    let armed = propsRef.current.pageCount === 0 || propsRef.current.retakePage !== null;
    let firstQuad: Quad | null = null;
    const small = makeCanvas(1, 1);
    const g = ctx2d(small, true);

    const tick = () => {
      if (stopped) return;
      const t0 = performance.now();
      const vw = v.videoWidth, vh = v.videoHeight;
      if (vw && vh && !capturingRef.current && v.readyState >= 2) {
        const { width, height } = fitSize(vw, vh, 480);
        if (small.width !== width || small.height !== height) { small.width = width; small.height = height; }
        g.drawImage(v, 0, 0, width, height);
        let mat = null;
        let quad: Quad | null = null, good = false;
        try {
          mat = matFromCanvas(cv, small);
          const d = detectDocument(cv, mat, { workSize: 480, prior });
          if (d.found && d.confidence >= MIN_CONFIDENCE) {
            quad = d.quad;
            good = d.confidence >= GOOD_CONFIDENCE;
          }
        } catch {
          /* a bad frame: skip it */
        } finally {
          freeMat(mat);
        }
        prior = quad;
        const steady = !!(quad && good && prev && isSteady(prev, quad, width, height));
        if (steady) steadySince = steadySince || t0;
        else steadySince = quad && good ? t0 : 0;
        prev = quad;
        if (!armed) {
          if (!quad) armed = true;
          else if (!firstQuad) firstQuad = quad;
          else if (maxCornerDistance(firstQuad, quad) > NEW_PAGE_MOVE * Math.hypot(width, height)) armed = true;
        }
        const held = armed && steady && t0 - steadySince >= STEADY_MS;
        drawOutline(overlayRef.current, v, quad ? scaleQuad(quad, vw / width, vh / height) : null, good);
        const nextHint = quad ? (!armed && autoRef.current ? 'swap' : good && steadySince ? 'steady' : 'found') : 'none';
        if (nextHint !== lastHint) { lastHint = nextHint; setHint(nextHint); }
        if (held && autoRef.current) {
          void capture();
          return;
        }
      }
      timer = setTimeout(tick, Math.max(40, DETECT_EVERY_MS - (performance.now() - t0)));
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
      freeCanvas(small);
      drawOutline(overlayRef.current, v, null, false);
    };
  }, [props.cv, videoReady, state]);


  const capture = async () => {
    const v = videoRef.current;
    if (!v || capturingRef.current) return;
    capturingRef.current = true;
    setCapturing(true);
    try {
      const p = propsRef.current;
      const blob = await p.camera.takeStill(v);
      propsRef.current.onStill(blob, 'camera');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t take the photo. Try again.');
      capturingRef.current = false;
      setCapturing(false);
    }
  };

  const toggleTorch = async () => {
    const next = !torch;
    if (await props.camera.setTorch(next)) setTorch(next);
  };

  const onFile = (e: JSX.TargetedEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (file) props.onStill(file, 'file');
  };

  const what = props.subject === 'photo' ? 'the parts receipt or packaging' : 'the receipt';
  const status = state === 'starting'
    ? 'Opening the camera…'
    : props.cvStatus === 'loading' || (props.cvStatus === 'idle' && state === 'live')
      ? 'Getting the scanner ready…'
      : props.cvStatus === 'failed'
        ? 'Take the photo, then set the corners yourself.'
        : hint === 'swap'
          ? 'Put the next page in view, or tap the button.'
          : hint === 'steady'
          ? auto ? 'Hold steady…' : 'Looks good. Tap the button.'
          : hint === 'found'
            ? 'Hold steady, or move a little closer.'
            : `Point the camera at ${what}.`;

  const title = props.retakePage ? `Retake page ${props.retakePage}` : props.subject === 'photo' ? 'Photo' : `Page ${props.pageCount + 1}`;

  return (
    <div class="cam">
      <div class="cam-bar">
        <button type="button" class="cam-round" onClick={props.onClose} aria-label={props.pageCount ? 'Close camera' : 'Cancel'}>
          <Icon name="close" size={22} />
        </button>
        <h2 class="cam-title">{title}</h2>
        {state === 'live' && torchOk ? (
          <button type="button" class={`cam-round${torch ? ' cam-on' : ''}`} onClick={() => void toggleTorch()} aria-pressed={torch} aria-label="Flashlight">
            <Icon name="sun" size={22} />
          </button>
        ) : <span class="cam-round-spacer" />}
      </div>

      {state === 'fallback' || state === 'ended' ? (
        <div class="cam-fallback">
          <Icon name="camera" size={40} />
          <p role="status">{state === 'ended' ? 'The camera turned off while the app was in the background.' : error}</p>
          <label class="btn btn-primary cam-file-btn">
            <Icon name="camera" size={20} />
            <span>Take a photo</span>
            <input
              type="file"
              accept="image/*"
              capture="environment"
              class="visually-hidden"
              aria-label="Take a photo"
              onChange={onFile}
            />
          </label>
          {CameraSession.supported() && (
            <button type="button" class="btn btn-plain cam-retry" onClick={props.onRetryCamera}>
              {state === 'ended' ? 'Turn the camera back on' : 'Try the live camera again'}
            </button>
          )}
        </div>
      ) : (
        <div class="cam-stage">
          <video
            ref={videoRef}
            class="cam-video"
            playsInline
            muted
            autoPlay
            aria-label="Camera preview"
            onLoadedMetadata={() => setVideoReady(true)}
          />
          <canvas ref={overlayRef} class="cam-overlay" aria-hidden="true" />
          {capturing && <div class="cam-flash" aria-hidden="true" />}
          <p class="cam-hint" role="status" aria-live="polite">{status}</p>
          {error && <p class="cam-error" role="alert">{error}</p>}
        </div>
      )}

      <div class="cam-controls">
        <div class="cam-side">
          {props.pageCount > 0 && (
            <button type="button" class="cam-pages" onClick={props.onShowPages}>
              {props.pageCount} {props.pageCount === 1 ? 'page' : 'pages'}
            </button>
          )}
        </div>
        {state === 'live' || state === 'starting' ? (
          <button
            type="button"
            class="cam-shutter"
            aria-label="Take photo"
            disabled={state !== 'live' || !videoReady || capturing}
            onClick={() => void capture()}
          >
            <span class="cam-shutter-inner" />
          </button>
        ) : <span />}
        <div class="cam-side cam-side-right">
          {state === 'live' && (
            <button type="button" class={`cam-auto${auto ? ' cam-on' : ''}`} aria-pressed={auto} onClick={() => { setAuto(!auto); setAutoCapture(!auto); }}>
              Auto
              <span class="visually-hidden"> capture when the outline holds steady</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Draws the detected outline over the video (object-fit: contain), in CSS pixels × DPR. */
function drawOutline(canvas: HTMLCanvasElement | null, video: HTMLVideoElement, quad: Quad | null, good: boolean): void {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = Math.round(rect.width * dpr), h = Math.round(rect.height * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const g = canvas.getContext('2d');
  if (!g) return;
  g.clearRect(0, 0, w, h);
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!quad || !vw || !vh) return;
  const s = Math.min(w / vw, h / vh);
  const ox = (w - vw * s) / 2, oy = (h - vh * s) / 2;
  const pts = quadPoints(quad).map(p => ({ x: ox + p.x * s, y: oy + p.y * s }));
  g.beginPath();
  pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
  g.closePath();
  g.fillStyle = good ? 'rgba(52, 199, 89, 0.22)' : 'rgba(10, 132, 255, 0.18)';
  g.fill();
  g.lineWidth = 3 * dpr;
  g.lineJoin = 'round';
  g.strokeStyle = good ? '#34c759' : '#0a84ff';
  g.stroke();
}
