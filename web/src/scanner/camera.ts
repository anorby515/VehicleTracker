/**
 * The rear camera for the scanner (docs: ios-pwa research, spec 7.3).
 *
 * - getUserMedia is only called from a tap, and ONE stream is reused for
 *   every page of a scan: in a home-screen app iOS asks for permission once
 *   per app launch, and again when the URL hash changes, so the scanner is an
 *   overlay, never a route.
 * - Resolution: ask for 4K ("ideal"), use whatever arrives (1080p is the
 *   baseline); trust videoWidth/videoHeight over the constraints.
 * - Stills: ImageCapture.takePhoto() (iOS 18.4+) with a 3 s timeout, else the
 *   current video frame at full size.
 * - Torch: offered only when the track says it can.
 */

import { canvasToBlob, ctx2d, freeCanvas, makeCanvas } from './image';

interface ImageCaptureLike { takePhoto(): Promise<Blob> }
type ImageCaptureCtor = new (track: MediaStreamTrack) => ImageCaptureLike;

export const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
  audio: false,
};

/** A friendly reason the camera couldn't open. */
export function cameraErrorMessage(e: unknown): string {
  const name = e instanceof Error ? e.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera access is turned off for this app. You can still take a photo with the iPhone camera below.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
    return 'No camera was found. You can pick or take a photo below instead.';
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return 'The camera is busy (another app may be using it). You can take a photo with the iPhone camera below.';
  }
  return 'The camera couldn’t open. You can take a photo with the iPhone camera below.';
}

export class CameraSession {
  private stream: MediaStream | null = null;
  private opening: Promise<MediaStream> | null = null;

  /** Whether this browser can do live camera at all. */
  static supported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  }

  /** The live stream, opening it if needed. Call from a tap handler. */
  open(): Promise<MediaStream> {
    if (this.live()) { this.resume(); return Promise.resolve(this.stream!); }
    if (this.opening) return this.opening;
    if (!CameraSession.supported()) {
      const e = new Error('No camera support');
      e.name = 'NotFoundError';
      return Promise.reject(e);
    }
    this.opening = navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS)
      .then(s => { this.stream = s; return s; })
      .finally(() => { this.opening = null; });
    return this.opening;
  }

  get current(): MediaStream | null {
    return this.live() ? this.stream : null;
  }

  track(): MediaStreamTrack | null {
    return this.stream?.getVideoTracks()[0] ?? null;
  }

  live(): boolean {
    const t = this.track();
    return !!t && t.readyState === 'live';
  }

  /** Keeps the stream but stops delivering frames (between pages). */
  pause(): void {
    const t = this.track();
    if (t) t.enabled = false;
  }

  resume(): void {
    const t = this.track();
    if (t) t.enabled = true;
  }

  /** Turns the camera off completely. */
  stop(): void {
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
  }

  torchSupported(): boolean {
    try {
      const caps = this.track()?.getCapabilities?.() as (MediaTrackCapabilities & { torch?: boolean }) | undefined;
      return !!caps?.torch;
    } catch {
      return false;
    }
  }

  async setTorch(on: boolean): Promise<boolean> {
    try {
      await this.track()?.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
      return true;
    } catch {
      return false;
    }
  }

  /** A full-resolution still: takePhoto() when available (3 s timeout), else the video frame. */
  async takeStill(video: HTMLVideoElement): Promise<Blob> {
    const track = this.track();
    const IC = (window as unknown as { ImageCapture?: ImageCaptureCtor }).ImageCapture;
    if (track && IC) {
      try {
        const photo = await Promise.race([
          new IC(track).takePhoto(),
          new Promise<null>(r => setTimeout(() => r(null), 3000)),
        ]);
        if (photo && photo.size > 0) return photo;
      } catch {
        /* fall back to the video frame */
      }
    }
    return grabFrame(video);
  }
}

/** The current video frame at its native size, as a JPEG. */
export async function grabFrame(video: HTMLVideoElement): Promise<Blob> {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) throw new Error('The camera isn’t ready yet.');
  const c = makeCanvas(w, h);
  try {
    ctx2d(c).drawImage(video, 0, 0, w, h);
    return await canvasToBlob(c, 'image/jpeg', 0.92);
  } finally {
    freeCanvas(c);
  }
}
