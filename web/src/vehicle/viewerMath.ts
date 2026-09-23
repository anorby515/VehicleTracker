/**
 * Numbers for the document viewer: zoom levels, keeping the point under the
 * fingers still while zooming, and canvas sizes that stay inside iOS limits.
 */

/** iOS Safari refuses canvases larger than this many pixels (width × height). */
export const MAX_CANVAS_PIXELS = 16_777_216;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
/** Steps for the − / + buttons. */
export const ZOOM_STEPS = [1, 1.5, 2, 3, 4];

export function clampZoom(z: number): number {
  if (!isFinite(z)) return MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/** The next button step above (dir = 1) or below (dir = -1) the current zoom. */
export function nextZoomStep(current: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find(s => s > current + 0.01) ?? MAX_ZOOM;
  return [...ZOOM_STEPS].reverse().find(s => s < current - 0.01) ?? MIN_ZOOM;
}

/**
 * Scroll offsets that keep the content point under the focal point (fx, fy,
 * relative to the viewport) in place when the zoom goes from `from` to `to`.
 * Content scales with the zoom from its top-left corner.
 */
export function scrollForZoom(
  scroll: { left: number; top: number },
  focal: { x: number; y: number },
  from: number,
  to: number,
): { left: number; top: number } {
  const k = to / from;
  return {
    left: Math.max(0, (scroll.left + focal.x) * k - focal.x),
    top: Math.max(0, (scroll.top + focal.y) * k - focal.y),
  };
}

/**
 * pdf.js scale for a page `pageW × pageH` (PDF points) drawn `cssWidth` CSS
 * px wide at `dpr`, reduced so the canvas stays within MAX_CANVAS_PIXELS.
 */
export function canvasScale(pageW: number, pageH: number, cssWidth: number, dpr: number, maxPixels = MAX_CANVAS_PIXELS): number {
  if (!(pageW > 0) || !(pageH > 0) || !(cssWidth > 0)) return 1;
  const want = (cssWidth * Math.max(1, dpr)) / pageW;
  const pixels = pageW * pageH * want * want;
  if (pixels <= maxPixels) return want;
  // Floor-safe: a hair under the cap so rounding the canvas size up can't exceed it.
  return Math.sqrt(maxPixels / (pageW * pageH)) * 0.999;
}

/** Distance between two points (pinch). */
export function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function driveUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
}
