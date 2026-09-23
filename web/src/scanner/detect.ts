/**
 * Receipt edge detection (pure: OpenCV Mat in → corners out).
 *
 * Several strategies each propose candidate quads; every candidate is then
 * snapped to the strongest nearby straight edges and scored, and the best
 * one wins:
 *
 * (a) Edges: Canny with automatic thresholds (from the median, and from Otsu),
 *     dilated; contours → convex hull → approxPolyDP (1–5% of the perimeter),
 *     diagonal extremes and the min-area rectangle.
 * (b) Paper is bright: Otsu on the blurred luminance, on "whiteness"
 *     (min of R, G, B: bright AND unsaturated) and an adaptive threshold for
 *     shadows; morphological close/open; the largest blobs → quads as above.
 * (c) jscanify's method (Canny 50/200 → blur → Otsu → largest contour →
 *     farthest point per quadrant) as a fallback proposal.
 *
 * Scoring: edge support (fraction of each side backed by a same-polarity
 * gradient across it), the weakest side's support, rectangularity (angles
 * near 90°), area, paper-brighter-than-surroundings contrast, and aspect
 * plausibility (receipts run from 1:1 to about 1:6).
 *
 * Nothing plausible → the default 8% inset rectangle with low confidence, so
 * the person drags the corners. Every Mat is freed (MatScope + finally).
 */

import type { CV, Mat } from './cv';
import { MatScope, toGray } from './cv';
import {
  type Pt, type Quad, aspectRatio, cornerAngles, defaultQuad, dist, intersectLines, isConvex,
  maxCornerDistance, orderCorners, quadArea, quadPoints, scaleQuad,
} from './geometry';

export interface Detection {
  /** Corners in source-image pixels. */
  quad: Quad;
  /** 0..1. ≥ GOOD_CONFIDENCE means the outline is trustworthy (auto-capture may fire). */
  confidence: number;
  /** False when nothing plausible was found and `quad` is the default inset. */
  found: boolean;
  /** Which proposal won (debugging and tests). */
  strategy: string;
}

export interface DetectOptions {
  /** Long edge of the internal working image. 480 for live preview, ~800 for stills. */
  workSize?: number;
  /**
   * Smallest share of the frame a receipt may cover (default 8%). Lower than
   * the usual 15% because a long receipt (1:4–1:6) filling the frame's height
   * covers only 10–20% of it; the area score still prefers bigger outlines.
   */
  minAreaRatio?: number;
  /**
   * The previous frame's outline (source pixels). When it still fits the
   * edges well, it is refined and returned without running every strategy,
   * which keeps the live preview cheap while the phone is held steady.
   */
  prior?: Quad | null;
  /** Debug hook: every scored proposal, best first. */
  onCandidates?: (list: { source: string; score: number; quad: Quad }[], counts: Record<string, number>) => void;
}

export const GOOD_CONFIDENCE = 0.6;
/** Below this, the best candidate isn't trusted at all. */
export const MIN_CONFIDENCE = 0.42;
/** Proposals run on a smaller copy; refinement restores full working precision. */
const PROPOSAL_SIZE = 320;

interface Candidate { quad: Quad; source: string }
interface Scored { quad: Quad; source: string; score: number }

/** One resolution of the input. */
interface Img {
  cv: CV;
  s: MatScope;
  w: number;
  h: number;
  /** RGBA/RGB copy at this size, or null for grey input. */
  color: Mat | null;
  gray: Mat;
  blur: Mat;
  minArea: number;
}

/** The working image plus its gradients (scoring and refinement). */
interface Ctx extends Img {
  dx: Float32Array;
  dy: Float32Array;
  grayData: Uint8Array;
  /** Gradient threshold for "there is an edge here" (Sobel units, ≈ a 10-level step). */
  tau: number;
}

function makeImg(cv: CV, s: MatScope, src: Mat, w: number, h: number, minAreaRatio: number): Img {
  let sized = src;
  if (w !== src.cols || h !== src.rows) {
    sized = s.mat();
    cv.resize(src, sized, new cv.Size(w, h), 0, 0, cv.INTER_AREA);
  }
  const gray = s.mat();
  toGray(cv, sized, gray);
  const blur = s.mat();
  cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
  return { cv, s, w, h, color: sized.channels() >= 3 ? sized : null, gray, blur, minArea: minAreaRatio * w * h };
}

export function detectDocument(cv: CV, src: Mat, opts: DetectOptions = {}): Detection {
  const W = src.cols, H = src.rows;
  const fallback = (confidence = 0.05): Detection => ({
    quad: defaultQuad(W || 1, H || 1), confidence, found: false, strategy: 'default',
  });
  if (!W || !H || src.empty() || W < 16 || H < 16) return fallback(0);

  const workSize = opts.workSize ?? 480;
  const minAreaRatio = opts.minAreaRatio ?? 0.08;
  const s = new MatScope(cv);
  try {
    const scale = Math.min(1, workSize / Math.max(W, H));
    const w = Math.max(16, Math.round(W * scale));
    const h = Math.max(16, Math.round(H * scale));
    const sx = W / w, sy = H / h;
    const img = makeImg(cv, s, src, w, h, minAreaRatio);
    const gx = s.mat(), gy = s.mat();
    cv.Sobel(img.blur, gx, cv.CV_32F, 1, 0, 3, 1, 0, cv.BORDER_REPLICATE);
    cv.Sobel(img.blur, gy, cv.CV_32F, 0, 1, 3, 1, 0, cv.BORDER_REPLICATE);
    const ctx: Ctx = { ...img, dx: gx.data32F, dy: gy.data32F, grayData: img.gray.data, tau: 30 };
    const diag = Math.hypot(w, h);

    const polish = (c: Scored): Scored => {
      let q = c.quad, sc = c.score;
      for (const radius of [Math.max(5, diag * 0.025), Math.max(3, diag * 0.01)]) {
        const r = refineQuad(ctx, q, radius);
        if (!r || !plausible(ctx, r) || maxCornerDistance(r, c.quad) > diag * 0.08) continue;
        const rs = scoreQuad(ctx, r);
        if (rs >= sc - 0.01) { q = r; sc = rs; }
      }
      return { quad: q, source: c.source, score: sc };
    };
    const done = (b: Scored): Detection => ({
      quad: scaleQuad(b.quad, sx, sy),
      confidence: Math.max(0, Math.min(1, b.score)),
      found: true,
      strategy: b.source,
    });

    // Live preview: follow the previous outline cheaply while it still fits.
    if (opts.prior) {
      const pq = scaleQuad(opts.prior, 1 / sx, 1 / sy);
      if (plausible(ctx, pq)) {
        const t = polish({ quad: pq, source: 'tracked', score: scoreQuad(ctx, pq) });
        if (t.score >= GOOD_CONFIDENCE) return done(t);
      }
    }

    // Proposals on a smaller copy.
    const pscale = Math.min(1, PROPOSAL_SIZE / Math.max(w, h));
    const pimg = pscale < 1
      ? makeImg(cv, s, img.color ?? img.gray, Math.max(16, Math.round(w * pscale)), Math.max(16, Math.round(h * pscale)), minAreaRatio)
      : img;
    const raw: Candidate[] = [];
    edgeProposals(pimg, raw);
    brightProposals(pimg, raw);
    jscanifyProposal(pimg, raw);
    const up = w / pimg.w, upy = h / pimg.h;

    const scored: Scored[] = [];
    const seen: Quad[] = [];
    for (const c of raw) {
      const q = scaleQuad(c.quad, up, upy);
      if (!plausible(ctx, q)) continue;
      if (seen.some(o => maxCornerDistance(o, q) < 2)) continue;
      seen.push(q);
      const sc = scoreQuad(ctx, q);
      if (sc > 0) scored.push({ quad: q, source: c.source, score: sc });
    }
    scored.sort((a, b) => b.score - a.score);
    if (opts.onCandidates) {
      const counts: Record<string, number> = {};
      for (const c of raw) counts[c.source] = (counts[c.source] ?? 0) + 1;
      opts.onCandidates(scored.map(c => ({ ...c, quad: scaleQuad(c.quad, sx, sy) })), counts);
    }

    let best: Scored | null = null;
    for (const c of scored.slice(0, 4)) {
      const p = polish(c);
      if (!best || p.score > best.score) best = p;
    }
    if (!best || best.score < MIN_CONFIDENCE) return fallback(best ? Math.min(0.2, best.score / 2) : 0.05);
    return done(best);
  } catch (e) {
    if (opts.onCandidates) throw e;
    return fallback(0);
  } finally {
    s.release();
  }
}

// ------------------------------------------------------------------ proposals

function edgeProposals(ctx: Img, out: Candidate[]): void {
  const { cv, s, blur } = ctx;
  // Automatic thresholds: from the median (the classic "auto Canny", sigma 0.33),
  // from Otsu's threshold, and a low fixed pair for faint paper-on-pale edges.
  const med = median(ctx.gray.data);
  const tmp = s.mat();
  const otsu = cv.threshold(blur, tmp, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU) as number;
  const settings: [number, number, string][] = [
    [Math.max(10, 0.67 * med), Math.max(30, 1.33 * med), 'edges-median'],
    [Math.max(10, otsu * 0.5), Math.max(30, otsu), 'edges-otsu'],
    [20, 60, 'edges-low'],
  ];
  const kernel = s.track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
  for (const [lo, hi, name] of settings) {
    const edges = s.mat();
    cv.Canny(blur, edges, lo, hi, 3, true);
    cv.dilate(edges, edges, kernel, new cv.Point(-1, -1), 1);
    contourProposals(ctx, edges, cv.RETR_LIST, name, 6, out);
  }
}

function brightProposals(ctx: Img, out: Candidate[]): void {
  const { cv, s, w, h, color: small } = ctx;
  const long = Math.max(w, h);
  const k = (f: number) => { const n = Math.max(3, Math.round(long * f)); return n % 2 ? n : n + 1; };
  const close = s.track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(k(0.02), k(0.02))));
  const open = s.track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(k(0.012), k(0.012))));

  const masks: [Mat, string][] = [];

  // Luminance (paper brighter than the surface it lies on).
  const lum = s.mat();
  cv.GaussianBlur(ctx.gray, lum, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
  const m1 = s.mat();
  cv.threshold(lum, m1, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
  masks.push([m1, 'bright-otsu']);

  // Whiteness = min(R,G,B): bright and unsaturated, which colourful clutter isn't.
  if (small) {
    const wh = s.mat(h, w, cv.CV_8UC1);
    const d = small.data, ch = small.channels(), o = wh.data;
    for (let i = 0, j = 0; j < o.length; i += ch, j++) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      o[j] = r < g ? (r < b ? r : b) : (g < b ? g : b);
    }
    const whb = s.mat();
    cv.GaussianBlur(wh, whb, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
    const m2 = s.mat();
    cv.threshold(whb, m2, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
    masks.push([m2, 'bright-white']);
  }

  // Local brightness (uneven light / shadows across the page).
  const m3 = s.mat();
  cv.adaptiveThreshold(lum, m3, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY, k(0.25), -4);
  masks.push([m3, 'bright-adaptive']);

  for (const [m, name] of masks) {
    cv.morphologyEx(m, m, cv.MORPH_CLOSE, close);
    cv.morphologyEx(m, m, cv.MORPH_OPEN, open);
    contourProposals(ctx, m, cv.RETR_EXTERNAL, name, 3, out);
  }
}

function jscanifyProposal(ctx: Img, out: Candidate[]): void {
  const { cv, s } = ctx;
  const edges = s.mat();
  cv.Canny(ctx.gray, edges, 50, 200);
  const b = s.mat();
  cv.GaussianBlur(edges, b, new cv.Size(3, 3), 0, 0, cv.BORDER_DEFAULT);
  const t = s.mat();
  cv.threshold(b, t, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
  const contours = s.vec();
  const hier = s.mat();
  cv.findContours(t, contours, hier, cv.RETR_CCOMP, cv.CHAIN_APPROX_SIMPLE);
  let bestArea = 0, bestPts: Pt[] | null = null;
  for (let i = 0; i < contours.size(); i++) {
    const c = s.track(contours.get(i));
    const a = cv.contourArea(c) as number;
    if (a > bestArea) { bestArea = a; bestPts = matPoints(c); }
  }
  if (!bestPts || bestArea < ctx.minArea * 0.5) return;
  const xs = bestPts.map(p => p.x), ys = bestPts.map(p => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const q = quadrantExtremes(bestPts, cx, cy);
  if (q) out.push({ quad: q, source: 'jscanify' });
}

/** Top-N contours by area → hull → approxPolyDP quad, diagonal extremes, min-area rect. */
function contourProposals(ctx: Img, binary: Mat, mode: number, source: string, topN: number, out: Candidate[]): void {
  const { cv, s } = ctx;
  const contours = s.vec();
  const hier = s.mat();
  cv.findContours(binary, contours, hier, mode, cv.CHAIN_APPROX_SIMPLE);
  const n = contours.size();
  const areas: { i: number; a: number }[] = [];
  for (let i = 0; i < n; i++) {
    const c = contours.get(i);
    try {
      const a = cv.contourArea(c) as number;
      if (a >= ctx.minArea * 0.6) areas.push({ i, a });
    } finally {
      c.delete();
    }
  }
  areas.sort((x, y) => y.a - x.a);
  for (const { i } of areas.slice(0, topN)) {
    const c = s.track(contours.get(i));
    const hull = s.mat();
    cv.convexHull(c, hull, false, true);
    const hullPts = matPoints(hull);
    if (hullPts.length < 4) continue;
    const peri = cv.arcLength(hull, true) as number;
    for (const eps of [0.01, 0.015, 0.02, 0.03, 0.04, 0.05]) {
      const approx = s.mat();
      cv.approxPolyDP(hull, approx, eps * peri, true);
      if (approx.rows === 4) {
        out.push({ quad: orderCorners(matPoints(approx)), source: `${source}-poly` });
        break;
      }
      if (approx.rows < 4) break;
    }
    out.push({ quad: diagonalExtremes(hullPts), source: `${source}-extremes` });
    const rr = cv.minAreaRect(hull);
    out.push({ quad: orderCorners(cv.RotatedRect.points(rr).map(p => ({ x: p.x, y: p.y }))), source: `${source}-rect` });
  }
}

// ------------------------------------------------------------------ scoring

function plausible(ctx: Ctx, q: Quad): boolean {
  if (!isConvex(q)) return false;
  const area = quadArea(q);
  if (area < ctx.minArea || area > 0.985 * ctx.w * ctx.h) return false;
  const pad = 0.03 * Math.max(ctx.w, ctx.h);
  for (const p of quadPoints(q)) {
    if (p.x < -pad || p.y < -pad || p.x > ctx.w + pad || p.y > ctx.h + pad) return false;
  }
  if (cornerAngles(q).some(a => a < 40 || a > 140)) return false;
  return aspectRatio(q) <= 8;
}

/** 0..1, or 0 for implausible. */
function scoreQuad(ctx: Ctx, q: Quad): number {
  const pts = quadPoints(q);
  const sides: number[] = [];
  for (let i = 0; i < 4; i++) sides.push(sideSupport(ctx, pts[i], pts[(i + 1) % 4]));
  const support = sides.reduce((a, b) => a + b, 0) / 4;
  const minSupport = Math.min(...sides);
  // A real sheet of paper has visible edges; without them it's a guess.
  if (support < 0.3 || minSupport < 0.1) return 0;

  const dev = cornerAngles(q).reduce((a, x) => a + Math.abs(x - 90), 0) / 4;
  const rect = clamp01(1 - dev / 35);

  const areaRatio = quadArea(q) / (ctx.w * ctx.h);
  const areaScore = clamp01((areaRatio - 0.05) / 0.4);

  const ar = aspectRatio(q);
  const aspectScore = ar <= 6 ? 1 : clamp01((8 - ar) / 2);

  const contrastScore = clamp01(contrast(ctx, q) / 60);

  return 0.35 * support + 0.15 * minSupport + 0.15 * rect + 0.15 * areaScore + 0.1 * contrastScore + 0.1 * aspectScore;
}

/** Share of samples along a side with a strong, same-polarity gradient across it. */
function sideSupport(ctx: Ctx, a: Pt, b: Pt): number {
  const len = dist(a, b);
  if (len < 4) return 0;
  const n = Math.max(12, Math.min(160, Math.round(len / 3)));
  const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
  const nx = -uy, ny = ux;
  const vals: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = 0.06 + (0.88 * i) / (n - 1);
    const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
    let best = 0;
    for (let k = -2; k <= 2; k++) {
      const g = gradAlong(ctx, px + k * nx, py + k * ny, nx, ny);
      if (Math.abs(g) > Math.abs(best)) best = g;
    }
    vals.push(best);
  }
  let pos = 0, neg = 0;
  for (const v of vals) {
    if (v >= ctx.tau) pos++;
    else if (v <= -ctx.tau) neg++;
  }
  return Math.max(pos, neg) / n;
}

/** Mean brightness inside the quad minus a band just outside it. */
function contrast(ctx: Ctx, q: Quad): number {
  const c = { x: (q.tl.x + q.tr.x + q.br.x + q.bl.x) / 4, y: (q.tl.y + q.tr.y + q.br.y + q.bl.y) / 4 };
  const shrink = (f: number): Quad => {
    const m = (p: Pt) => ({ x: c.x + (p.x - c.x) * f, y: c.y + (p.y - c.y) * f });
    return { tl: m(q.tl), tr: m(q.tr), br: m(q.br), bl: m(q.bl) };
  };
  const inner = shrink(0.9), outer = shrink(1.08);
  const { w, h, grayData } = ctx;
  let inSum = 0, inN = 0, outSum = 0, outN = 0;
  // Sample on a coarse grid over the outer quad's bounding box.
  const op = quadPoints(outer);
  const x0 = Math.max(0, Math.floor(Math.min(...op.map(p => p.x))));
  const x1 = Math.min(w - 1, Math.ceil(Math.max(...op.map(p => p.x))));
  const y0 = Math.max(0, Math.floor(Math.min(...op.map(p => p.y))));
  const y1 = Math.min(h - 1, Math.ceil(Math.max(...op.map(p => p.y))));
  const step = Math.max(2, Math.round(Math.max(w, h) / 160));
  const pin = quadPoints(inner), pq = quadPoints(q);
  for (let y = y0; y <= y1; y += step) {
    for (let x = x0; x <= x1; x += step) {
      const p = { x, y };
      if (inConvex(p, pin)) { inSum += grayData[y * w + x]; inN++; }
      else if (!inConvex(p, pq) && inConvex(p, op)) { outSum += grayData[y * w + x]; outN++; }
    }
  }
  if (!inN || !outN) return 0;
  return inSum / inN - outSum / outN;
}

// ------------------------------------------------------------------ refinement

/**
 * Snaps each side to the strongest same-polarity edge within `radius` px,
 * fits a robust line per side and intersects neighbours for new corners.
 */
function refineQuad(ctx: Ctx, q: Quad, radius: number): Quad | null {
  const pts = quadPoints(q);
  const lines: { p: Pt; d: Pt }[] = [];
  for (let i = 0; i < 4; i++) {
    const a = pts[i], b = pts[(i + 1) % 4];
    const len = dist(a, b);
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    const nx = -uy, ny = ux;
    const n = Math.max(12, Math.min(90, Math.round(len / 2.5)));
    const found: { x: number; y: number; g: number }[] = [];
    const r = Math.ceil(radius);
    for (let j = 0; j < n; j++) {
      const t = 0.1 + (0.8 * j) / (n - 1);
      const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
      let bestK = 0, bestW = -1, bestG = 0;
      const gs: number[] = [];
      for (let k = -r; k <= r; k++) {
        const g = gradAlong(ctx, px + k * nx, py + k * ny, nx, ny);
        gs.push(g);
        const wgt = Math.abs(g) * (1 - 0.35 * Math.abs(k) / (r + 1));
        if (wgt > bestW) { bestW = wgt; bestK = k; bestG = g; }
      }
      if (Math.abs(bestG) < ctx.tau) continue;
      // Sub-pixel peak (parabola through the neighbours).
      const idx = bestK + r;
      let off = 0;
      if (idx > 0 && idx < gs.length - 1) {
        const g0 = Math.abs(gs[idx - 1]), g1 = Math.abs(gs[idx]), g2 = Math.abs(gs[idx + 1]);
        const den = g0 - 2 * g1 + g2;
        if (den < 0) off = Math.max(-0.5, Math.min(0.5, (0.5 * (g0 - g2)) / den));
      }
      const kk = bestK + off;
      found.push({ x: px + kk * nx, y: py + kk * ny, g: bestG });
    }
    // Keep the dominant polarity only.
    const pos = found.filter(f => f.g > 0), neg = found.filter(f => f.g < 0);
    const use = pos.length >= neg.length ? pos : neg;
    if (use.length < Math.max(6, n * 0.3)) {
      lines.push({ p: a, d: { x: ux, y: uy } });
      continue;
    }
    const fit = robustLine(use);
    lines.push(fit ?? { p: a, d: { x: ux, y: uy } });
  }
  const corner = (l1: { p: Pt; d: Pt }, l2: { p: Pt; d: Pt }) =>
    intersectLines(l1.p, { x: l1.p.x + l1.d.x, y: l1.p.y + l1.d.y }, l2.p, { x: l2.p.x + l2.d.x, y: l2.p.y + l2.d.y });
  const tl = corner(lines[3], lines[0]);
  const tr = corner(lines[0], lines[1]);
  const br = corner(lines[1], lines[2]);
  const bl = corner(lines[2], lines[3]);
  if (!tl || !tr || !br || !bl) return null;
  const out = { tl, tr, br, bl };
  return isConvex(out) ? out : null;
}

/** Total-least-squares line with two rounds of outlier trimming. */
function robustLine(points: Pt[]): { p: Pt; d: Pt } | null {
  let pts = points;
  let line: { p: Pt; d: Pt } | null = null;
  for (let iter = 0; iter < 3; iter++) {
    if (pts.length < 3) break;
    const n = pts.length;
    let mx = 0, my = 0;
    for (const p of pts) { mx += p.x; my += p.y; }
    mx /= n; my /= n;
    let sxx = 0, syy = 0, sxy = 0;
    for (const p of pts) {
      const dx = p.x - mx, dy = p.y - my;
      sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    }
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const d = { x: Math.cos(theta), y: Math.sin(theta) };
    line = { p: { x: mx, y: my }, d };
    const res = pts.map(p => Math.abs((p.x - mx) * -d.y + (p.y - my) * d.x));
    const sorted = [...res].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const lim = Math.max(1.2, 2.5 * med);
    const next = pts.filter((_, i) => res[i] <= lim);
    if (next.length === pts.length) break;
    pts = next;
  }
  return line;
}

// ------------------------------------------------------------------ helpers

/** Directional gradient (bilinear) at (x, y) projected on (nx, ny). */
function gradAlong(ctx: Ctx, x: number, y: number, nx: number, ny: number): number {
  const { w, h, dx, dy } = ctx;
  if (x < 0 || y < 0 || x > w - 1.001 || y > h - 1.001) return 0;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const i = y0 * w + x0;
  const bil = (a: Float32Array) =>
    a[i] * (1 - fx) * (1 - fy) + a[i + 1] * fx * (1 - fy) + a[i + w] * (1 - fx) * fy + a[i + w + 1] * fx * fy;
  return bil(dx) * nx + bil(dy) * ny;
}

function matPoints(m: Mat): Pt[] {
  const d = m.data32S;
  const out: Pt[] = [];
  for (let i = 0; i + 1 < d.length; i += 2) out.push({ x: d[i], y: d[i + 1] });
  return out;
}

function diagonalExtremes(pts: Pt[]): Quad {
  let tl = pts[0], tr = pts[0], br = pts[0], bl = pts[0];
  for (const p of pts) {
    if (p.x + p.y < tl.x + tl.y) tl = p;
    if (p.x + p.y > br.x + br.y) br = p;
    if (p.x - p.y > tr.x - tr.y) tr = p;
    if (p.x - p.y < bl.x - bl.y) bl = p;
  }
  return { tl: { ...tl }, tr: { ...tr }, br: { ...br }, bl: { ...bl } };
}

/** jscanify: the farthest contour point from the centre in each quadrant. */
function quadrantExtremes(pts: Pt[], cx: number, cy: number): Quad | null {
  const best: Record<string, { p: Pt; d: number } | undefined> = {};
  for (const p of pts) {
    const dx = p.x - cx, dy = p.y - cy;
    const key = (dy < 0 ? 't' : 'b') + (dx < 0 ? 'l' : 'r');
    const d = dx * dx + dy * dy;
    if (!best[key] || d > best[key]!.d) best[key] = { p, d };
  }
  if (!best.tl || !best.tr || !best.br || !best.bl) return null;
  return { tl: { ...best.tl.p }, tr: { ...best.tr.p }, br: { ...best.br.p }, bl: { ...best.bl.p } };
}

function inConvex(p: Pt, poly: Pt[]): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (cross === 0) continue;
    const s = cross > 0 ? 1 : -1;
    if (!sign) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

function median(data: Uint8Array): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i++) hist[data[i]]++;
  let acc = 0;
  const half = data.length / 2;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= half) return v;
  }
  return 128;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
