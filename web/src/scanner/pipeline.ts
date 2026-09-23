/**
 * The scanner pipeline in the browser: a still (camera or picked photo) →
 * detected corners → after the person adjusts them, a flat, cleaned-up JPEG
 * page for the PDF (spec 7.1 steps 3–4, 7.3).
 */

import type { CV } from './cv';
import { freeMat } from './cv';
import { type Detection, detectDocument } from './detect';
import { type FilterMode, applyFilter } from './filters';
import { type Quad, clampQuad, defaultQuad, quadPoints, scaleQuad } from './geometry';
import { canvasToBlob, ctx2d, decodeToCanvas, drawScaled, freeCanvas, makeCanvas, matFromCanvas, matToCanvas, thumbnailUrl } from './image';
import { warpQuad } from './warp';

/** JPEG quality for PDF pages (~1 MB per 2,000 px page). */
export const PAGE_QUALITY = 0.8;
/** The API accepts up to 40 pages; a paper scan stops at 20 (spec 7.1 step 5). */
export const MAX_SCAN_PAGES = 20;

/** A decoded still, kept while its corners are adjusted. */
export interface SourceImage {
  /** Full-resolution pixels (≤ 12 MP). Freed with freeSource(). */
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  /** Where it came from: live camera or a picked/captured file. */
  origin: 'camera' | 'file';
}

/** One finished page. */
export interface ScannedPage {
  id: string;
  jpeg: Blob;
  width: number;
  height: number;
  /** Object URL of a small preview (revoked when the page is dropped). */
  thumb: string;
  filter: FilterMode;
}

let pageSeq = 0;
export function newPageId(): string {
  pageSeq++;
  return `p${Date.now().toString(36)}${pageSeq}`;
}

export async function loadSource(blob: Blob, origin: SourceImage['origin']): Promise<SourceImage> {
  const canvas = await decodeToCanvas(blob);
  return { canvas, width: canvas.width, height: canvas.height, origin };
}

export function freeSource(s: SourceImage | null | undefined): void {
  if (s) freeCanvas(s.canvas);
}

export function freePage(p: { thumb: string } | null | undefined): void {
  if (p?.thumb) URL.revokeObjectURL(p.thumb);
}

/** Detects the receipt on a still (on a ~1,000 px copy); corners in source pixels. */
export function detectOnSource(cv: CV | null, src: SourceImage): Detection {
  if (!cv) return { quad: defaultQuad(src.width, src.height), confidence: 0, found: false, strategy: 'no-opencv' };
  const small = drawScaled(src.canvas, 1000);
  const mat = matFromCanvas(cv, small);
  try {
    const d = detectDocument(cv, mat, { workSize: 800 });
    const sx = src.width / small.width, sy = src.height / small.height;
    return { ...d, quad: clampQuad(scaleQuad(d.quad, sx, sy), src.width, src.height) };
  } finally {
    mat.delete();
    freeCanvas(small);
  }
}

/**
 * Flattens and cleans up the chosen quad into a JPEG page. Without OpenCV
 * (it failed to load), the page is the quad's bounding box, uncleaned.
 */
export async function processPage(cv: CV | null, src: SourceImage, quad: Quad, filter: FilterMode): Promise<ScannedPage> {
  let out: HTMLCanvasElement;
  if (cv) {
    const mat = matFromCanvas(cv, src.canvas);
    let warped = null, cleaned = null;
    try {
      warped = warpQuad(cv, mat, quad);
      cleaned = applyFilter(cv, warped, filter);
      out = matToCanvas(cv, cleaned);
    } finally {
      freeMat(mat);
      freeMat(warped);
      freeMat(cleaned);
    }
  } else {
    const pts = quadPoints(quad);
    const x0 = Math.max(0, Math.min(...pts.map(p => p.x))), y0 = Math.max(0, Math.min(...pts.map(p => p.y)));
    const x1 = Math.min(src.width, Math.max(...pts.map(p => p.x))), y1 = Math.min(src.height, Math.max(...pts.map(p => p.y)));
    const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
    const s = Math.min(1, 2000 / Math.max(w, h));
    out = makeCanvas(w * s, h * s);
    ctx2d(out).drawImage(src.canvas, x0, y0, w, h, 0, 0, out.width, out.height);
  }
  try {
    const jpeg = await canvasToBlob(out, 'image/jpeg', PAGE_QUALITY);
    const thumb = await thumbnailUrl(out, 360);
    return { id: newPageId(), jpeg, width: out.width, height: out.height, thumb, filter };
  } finally {
    freeCanvas(out);
  }
}
