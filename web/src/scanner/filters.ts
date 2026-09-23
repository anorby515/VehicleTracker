/**
 * Cleanup filters applied after perspective correction.
 *
 * "Document" (default): grayscale; even lighting by dividing by a background
 * estimate (a morphological close — which lifts out the dark print — on a
 * small copy, blurred and scaled back up); mild unsharp masking; then a
 * continuous levels curve that turns the paper pure white and darkens faint
 * print. It never hard-binarizes, so thin thermal print stays legible for
 * Drive's OCR.
 *
 * "Photo": colour kept, light auto-levels from the luminance histogram
 * (the same curve on R, G and B, so no colour cast), at 80% strength.
 */

import type { CV, Mat } from './cv';
import { MatScope, toGray, toRgba } from './cv';

export type FilterMode = 'document' | 'photo';

export const FILTER_LABELS: Record<FilterMode, string> = { document: 'Document', photo: 'Photo' };

/** Returns a new RGBA Mat (caller deletes). */
export function applyFilter(cv: CV, src: Mat, mode: FilterMode): Mat {
  return mode === 'photo' ? photoFilter(cv, src) : documentFilter(cv, src);
}

export function documentFilter(cv: CV, src: Mat): Mat {
  const s = new MatScope(cv);
  try {
    const gray = s.mat();
    toGray(cv, src, gray);
    const W = gray.cols, H = gray.rows;

    // Background (paper + lighting) estimate on a ~500 px copy.
    const f = Math.min(1, 500 / Math.max(W, H));
    const sw = Math.max(8, Math.round(W * f)), sh = Math.max(8, Math.round(H * f));
    const small = s.mat();
    cv.resize(gray, small, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA);
    const k = oddAtLeast(Math.round(Math.max(sw, sh) / 45), 5);
    const kernel = s.track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(k, k)));
    const closed = s.mat();
    cv.morphologyEx(small, closed, cv.MORPH_CLOSE, kernel);
    cv.medianBlur(closed, closed, 5);
    cv.GaussianBlur(closed, closed, new cv.Size(0, 0), k / 2, k / 2, cv.BORDER_REPLICATE);
    const bg = s.mat();
    cv.resize(closed, bg, new cv.Size(W, H), 0, 0, cv.INTER_LINEAR);
    cv.max(bg, gray, bg);

    // Even lighting: paper → ~255 everywhere, print keeps its relative darkness.
    const norm = s.mat();
    cv.divide(gray, bg, norm, 255);

    // Mild sharpening (unsharp mask).
    const soft = s.mat();
    cv.GaussianBlur(norm, soft, new cv.Size(0, 0), 1.1, 1.1, cv.BORDER_REPLICATE);
    const sharp = s.mat();
    cv.addWeighted(norm, 1.5, soft, -0.5, 0, sharp);

    // Levels: paper → white, faint print darker (gamma > 1 on the 0..1 ramp).
    const hist = histogram(sharp.data);
    const paper = percentile(hist, sharp.data.length, 0.5);
    const hi = Math.max(60, Math.min(250, paper - 6));
    const lo = Math.max(0, Math.min(percentile(hist, sharp.data.length, 0.005), hi - 70));
    const lut = s.mat(1, 256, cv.CV_8UC1);
    for (let v = 0; v < 256; v++) {
      const x = v <= lo ? 0 : v >= hi ? 1 : (v - lo) / (hi - lo);
      lut.data[v] = Math.round(255 * Math.pow(x, 1.6));
    }
    const leveled = s.mat();
    cv.LUT(sharp, lut, leveled);

    const out = new cv.Mat();
    toRgba(cv, leveled, out);
    return out;
  } finally {
    s.release();
  }
}

export function photoFilter(cv: CV, src: Mat): Mat {
  const s = new MatScope(cv);
  try {
    const rgba = s.mat();
    toRgba(cv, src, rgba);
    const gray = s.mat();
    toGray(cv, rgba, gray);
    const hist = histogram(gray.data);
    const n = gray.data.length;
    const lo = percentile(hist, n, 0.005);
    const hi = Math.max(lo + 40, percentile(hist, n, 0.995));
    const lut = s.mat(1, 256, cv.CV_8UC1);
    for (let v = 0; v < 256; v++) {
      const stretched = Math.max(0, Math.min(255, ((v - lo) * 255) / (hi - lo)));
      lut.data[v] = v === 255 ? 255 : Math.round(v + 0.8 * (stretched - v));
    }
    const out = new cv.Mat();
    cv.LUT(rgba, lut, out);
    // Alpha stays opaque.
    const d = out.data;
    for (let i = 3; i < d.length; i += 4) d[i] = 255;
    return out;
  } finally {
    s.release();
  }
}

function histogram(data: Uint8Array): Uint32Array {
  const h = new Uint32Array(256);
  for (let i = 0; i < data.length; i++) h[data[i]]++;
  return h;
}

/** Value at the given fraction of pixels (0..1). */
function percentile(hist: Uint32Array, total: number, p: number): number {
  const target = total * p;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= target) return v;
  }
  return 255;
}

function oddAtLeast(n: number, min: number): number {
  const v = Math.max(min, n);
  return v % 2 ? v : v + 1;
}
