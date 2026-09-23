/**
 * Perspective correction: the chosen quad → a flat, upright page.
 *
 * The output size comes from the quad's edge lengths (the longer of each pair
 * of opposite sides), scaled so the long edge is about 2,000 px — enough for
 * Drive's OCR at roughly 1 MB per JPEG page. Long, narrow receipts get a bit
 * more (up to 3,500 px) so their width doesn't drop below legible, and
 * nothing is enlarged more than 2×. Always under Safari's 16.7 MP canvas cap.
 */

import type { CV, Mat } from './cv';
import { MatScope } from './cv';
import { type Quad, naturalSize, quadPoints } from './geometry';

export interface WarpOptions {
  /** Target long edge for an ordinary page (default 2000). */
  longEdge?: number;
  /** Hard cap on output pixels (default 12 MP, well under iOS's 16.7 MP). */
  maxPixels?: number;
}

export const TARGET_LONG_EDGE = 2000;

/** Output width × height for a quad. */
export function outputSize(q: Quad, opts: WarpOptions = {}): { width: number; height: number } {
  const base = opts.longEdge ?? TARGET_LONG_EDGE;
  const maxPixels = opts.maxPixels ?? 12_000_000;
  const nat = naturalSize(q);
  const long = Math.max(nat.width, nat.height, 1);
  const short = Math.max(1, Math.min(nat.width, nat.height));
  const aspect = long / short;
  const target = base * Math.min(1.75, Math.max(1, Math.sqrt(aspect / 1.5)));
  let scale = Math.min(target / long, 2);
  let width = Math.max(1, Math.round(nat.width * scale));
  let height = Math.max(1, Math.round(nat.height * scale));
  if (width * height > maxPixels) {
    scale = Math.sqrt(maxPixels / (width * height));
    width = Math.max(1, Math.floor(width * scale));
    height = Math.max(1, Math.floor(height * scale));
  }
  return { width, height };
}

/**
 * Flattens the quad from `src` (any channel count) into a new Mat of the
 * same type. The caller deletes the result.
 */
export function warpQuad(cv: CV, src: Mat, q: Quad, opts: WarpOptions = {}): Mat {
  const { width, height } = outputSize(q, opts);
  const s = new MatScope(cv);
  try {
    // Work on the quad's bounding box only (a 4K frame is big).
    const pts = quadPoints(q);
    const x0 = Math.max(0, Math.floor(Math.min(...pts.map(p => p.x))));
    const y0 = Math.max(0, Math.floor(Math.min(...pts.map(p => p.y))));
    const x1 = Math.min(src.cols, Math.ceil(Math.max(...pts.map(p => p.x))));
    const y1 = Math.min(src.rows, Math.ceil(Math.max(...pts.map(p => p.y))));
    if (x1 - x0 < 2 || y1 - y0 < 2) throw new Error('The crop is too small.');
    let region = s.track(src.roi({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }));

    // Shrinking a lot? Soften first so fine print doesn't alias.
    const nat = naturalSize(q);
    const factor = Math.max(width, height) / Math.max(nat.width, nat.height);
    if (factor < 0.7) {
      const blurred = s.mat();
      const sigma = Math.min(2, 0.35 / factor);
      cv.GaussianBlur(region, blurred, new cv.Size(0, 0), sigma, sigma, cv.BORDER_REPLICATE);
      region = blurred;
    }

    const srcPts = s.track(cv.matFromArray(4, 1, cv.CV_32FC2, [
      q.tl.x - x0, q.tl.y - y0, q.tr.x - x0, q.tr.y - y0, q.br.x - x0, q.br.y - y0, q.bl.x - x0, q.bl.y - y0,
    ]));
    const dstPts = s.track(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width, 0, width, height, 0, height]));
    const M = s.track(cv.getPerspectiveTransform(srcPts, dstPts));
    const out = new cv.Mat();
    cv.warpPerspective(region, out, M, new cv.Size(width, height), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
    return out;
  } finally {
    s.release();
  }
}
