/**
 * Pure quad geometry shared by detection, the live overlay, the corner
 * editor and the warp. Coordinates are image pixels (y down). Corners are
 * always ordered top-left, top-right, bottom-right, bottom-left (clockwise on
 * screen).
 */

export interface Pt { x: number; y: number }
export interface Quad { tl: Pt; tr: Pt; br: Pt; bl: Pt }
export type Corner = keyof Quad;
export const CORNERS: Corner[] = ['tl', 'tr', 'br', 'bl'];

export const CORNER_LABELS: Record<Corner, string> = {
  tl: 'Top left corner',
  tr: 'Top right corner',
  br: 'Bottom right corner',
  bl: 'Bottom left corner',
};

export function quadPoints(q: Quad): Pt[] {
  return [q.tl, q.tr, q.br, q.bl];
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Orders four points as tl, tr, br, bl: sorted clockwise around the centroid,
 * starting from the point nearest the top-left (smallest x + y). Stable for
 * rotations up to about ±45°.
 */
export function orderCorners(pts: Pt[]): Quad {
  if (pts.length !== 4) throw new Error('orderCorners needs 4 points');
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
  const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
  const sorted = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let start = 0;
  for (let i = 1; i < 4; i++) {
    if (sorted[i].x + sorted[i].y < sorted[start].x + sorted[start].y) start = i;
  }
  const o = [0, 1, 2, 3].map(i => sorted[(start + i) % 4]);
  return { tl: { ...o[0] }, tr: { ...o[1] }, br: { ...o[2] }, bl: { ...o[3] } };
}

/** Signed-area magnitude (shoelace). */
export function quadArea(q: Quad): number {
  const p = quadPoints(q);
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    a += p[i].x * p[j].y - p[j].x * p[i].y;
  }
  return Math.abs(a) / 2;
}

/** True when the quad is strictly convex (no self-intersection, no reflex corner). */
export function isConvex(q: Quad): boolean {
  const p = quadPoints(q);
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = p[i], b = p[(i + 1) % 4], c = p[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Interior angles in degrees, in corner order. */
export function cornerAngles(q: Quad): number[] {
  const p = quadPoints(q);
  return p.map((b, i) => {
    const a = p[(i + 3) % 4], c = p[(i + 1) % 4];
    const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
    const d = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
    if (d === 0) return 0;
    const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / d));
    return (Math.acos(cos) * 180) / Math.PI;
  });
}

/** Side lengths: top, right, bottom, left. */
export function sideLengths(q: Quad): [number, number, number, number] {
  return [dist(q.tl, q.tr), dist(q.tr, q.br), dist(q.br, q.bl), dist(q.bl, q.tl)];
}

/** Output size of the flattened page, from the longer of each pair of opposite sides. */
export function naturalSize(q: Quad): { width: number; height: number } {
  const [t, r, b, l] = sideLengths(q);
  return { width: Math.max(t, b), height: Math.max(l, r) };
}

/** Long side ÷ short side of the flattened page (≥ 1). */
export function aspectRatio(q: Quad): number {
  const { width, height } = naturalSize(q);
  const s = Math.min(width, height);
  return s <= 0 ? Infinity : Math.max(width, height) / s;
}

/** Largest distance between corresponding corners. */
export function maxCornerDistance(a: Quad, b: Quad): number {
  return Math.max(...CORNERS.map(c => dist(a[c], b[c])));
}

export function scaleQuad(q: Quad, sx: number, sy: number = sx): Quad {
  const f = (p: Pt) => ({ x: p.x * sx, y: p.y * sy });
  return { tl: f(q.tl), tr: f(q.tr), br: f(q.br), bl: f(q.bl) };
}

export function clampQuad(q: Quad, width: number, height: number): Quad {
  const f = (p: Pt) => ({ x: Math.max(0, Math.min(width, p.x)), y: Math.max(0, Math.min(height, p.y)) });
  return { tl: f(q.tl), tr: f(q.tr), br: f(q.br), bl: f(q.bl) };
}

/** The fallback crop: a rectangle inset by `margin` of each dimension (8% by default). */
export function defaultQuad(width: number, height: number, margin = 0.08): Quad {
  const mx = width * margin, my = height * margin;
  return {
    tl: { x: mx, y: my },
    tr: { x: width - mx, y: my },
    br: { x: width - mx, y: height - my },
    bl: { x: mx, y: height - my },
  };
}

/**
 * "Holding steady" test for auto-capture: every corner moved less than `tol`
 * (2% by default) of the frame diagonal.
 */
export function isSteady(a: Quad, b: Quad, width: number, height: number, tol = 0.02): boolean {
  return maxCornerDistance(a, b) < tol * Math.hypot(width, height);
}

/** Intersection of line p1-p2 with line p3-p4 (null when parallel). */
export function intersectLines(p1: Pt, p2: Pt, p3: Pt, p4: Pt): Pt | null {
  const d = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);
  if (Math.abs(d) < 1e-9) return null;
  const a = p1.x * p2.y - p1.y * p2.x;
  const b = p3.x * p4.y - p3.y * p4.x;
  return {
    x: (a * (p3.x - p4.x) - (p1.x - p2.x) * b) / d,
    y: (a * (p3.y - p4.y) - (p1.y - p2.y) * b) / d,
  };
}

/** Point in convex quad (inclusive). */
export function pointInQuad(p: Pt, q: Quad): boolean {
  const pts = quadPoints(q);
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[i], b = pts[(i + 1) % 4];
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (cross === 0) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}
