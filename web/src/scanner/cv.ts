/**
 * A small structural type for the parts of OpenCV.js (4.10, @techstark/opencv-js)
 * the scanner uses, plus a scope helper that frees every Mat it tracks.
 *
 * The browser loads OpenCV from a static <script> (scanner/opencv.ts); Node
 * tests load the same file with createRequire. Neither goes through an ES
 * import, so the package's own (large, partly inaccurate) typings aren't used.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface Size { width: number; height: number }

export interface Mat {
  rows: number;
  cols: number;
  data: Uint8Array;
  data32S: Int32Array;
  data32F: Float32Array;
  data64F: Float64Array;
  type(): number;
  channels(): number;
  size(): Size;
  empty(): boolean;
  clone(): Mat;
  roi(rect: { x: number; y: number; width: number; height: number }): Mat;
  copyTo(dst: Mat, mask?: Mat): void;
  convertTo(dst: Mat, rtype: number, alpha?: number, beta?: number): void;
  setTo(value: unknown, mask?: Mat): Mat;
  isDeleted(): boolean;
  delete(): void;
}

export interface MatVector {
  size(): number;
  get(i: number): Mat;
  push_back(m: Mat): void;
  delete(): void;
}

export interface RotatedRect { center: { x: number; y: number }; size: Size; angle: number }

/** The OpenCV.js module (only what the scanner calls is spelled out; the rest is `any`). */
export interface CV {
  Mat: {
    new (): Mat;
    new (rows: number, cols: number, type: number): Mat;
    new (rows: number, cols: number, type: number, scalar: unknown): Mat;
    zeros(rows: number, cols: number, type: number): Mat;
    ones(rows: number, cols: number, type: number): Mat;
  };
  MatVector: { new (): MatVector };
  Size: new (w: number, h: number) => Size;
  Point: new (x: number, y: number) => { x: number; y: number };
  Scalar: new (a?: number, b?: number, c?: number, d?: number) => unknown;
  RotatedRect: { points(r: RotatedRect): { x: number; y: number }[] };
  matFromArray(rows: number, cols: number, type: number, data: ArrayLike<number>): Mat;
  matFromImageData(img: { width: number; height: number; data: Uint8ClampedArray }): Mat;
  minAreaRect(points: Mat): RotatedRect;
  [name: string]: any;
}

let liveTracked = 0;

/** Number of Mats created through a MatScope and not yet released (tests assert 0). */
export function liveScopedMats(): number {
  return liveTracked;
}

/**
 * Collects Mats/MatVectors and deletes them all in `release()`. Use in a
 * try/finally so nothing leaks on the WASM heap, whatever throws:
 *
 *   const s = new MatScope(cv);
 *   try { const g = s.mat(); cv.cvtColor(src, g, …); … } finally { s.release(); }
 */
export class MatScope {
  private items: { delete(): void; isDeleted?: () => boolean }[] = [];
  constructor(private readonly cv: CV) {}

  /** A new empty Mat (or rows×cols×type). */
  mat(rows?: number, cols?: number, type?: number): Mat {
    const m = rows === undefined ? new this.cv.Mat() : new this.cv.Mat(rows, cols!, type!);
    return this.track(m);
  }

  vec(): MatVector {
    return this.track(new this.cv.MatVector());
  }

  /** Tracks a Mat returned by OpenCV (clone, roi, getPerspectiveTransform…). */
  track<T extends { delete(): void }>(m: T): T {
    this.items.push(m);
    liveTracked++;
    return m;
  }

  /** Stops tracking `m` (the caller now owns it). */
  keep<T extends { delete(): void }>(m: T): T {
    const i = this.items.indexOf(m);
    if (i >= 0) {
      this.items.splice(i, 1);
      liveTracked--;
    }
    return m;
  }

  release(): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const m = this.items[i];
      try {
        if (!m.isDeleted || !m.isDeleted()) m.delete();
      } catch {
        /* already freed */
      }
      liveTracked--;
    }
    this.items = [];
  }
}

/** Frees a Mat if it exists and isn't freed yet. */
export function freeMat(m: { delete(): void; isDeleted?: () => boolean } | null | undefined): void {
  if (!m) return;
  try {
    if (!m.isDeleted || !m.isDeleted()) m.delete();
  } catch {
    /* ignore */
  }
}

/** Converts any 1/3/4-channel 8-bit Mat to grayscale into `dst`. */
export function toGray(cv: CV, src: Mat, dst: Mat): void {
  const ch = src.channels();
  if (ch === 4) cv.cvtColor(src, dst, cv.COLOR_RGBA2GRAY);
  else if (ch === 3) cv.cvtColor(src, dst, cv.COLOR_RGB2GRAY);
  else src.copyTo(dst);
}

/** Converts any 1/3/4-channel 8-bit Mat to RGBA into `dst`. */
export function toRgba(cv: CV, src: Mat, dst: Mat): void {
  const ch = src.channels();
  if (ch === 4) src.copyTo(dst);
  else if (ch === 3) cv.cvtColor(src, dst, cv.COLOR_RGB2RGBA);
  else cv.cvtColor(src, dst, cv.COLOR_GRAY2RGBA);
}
